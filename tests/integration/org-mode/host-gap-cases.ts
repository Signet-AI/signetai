import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "bun:test";
import { fixtureAnswer, type HostFixture, eventRows, rows } from "./host-fixture";
import { record, success, text, until, type Reply } from "./http";

export interface GapCase {
	signature: string;
	run(host: HostFixture): Promise<void>;
}
const cases: GapCase[] = [];
function proof(signature: string, run: GapCase["run"]): void {
	cases.push({ signature, run });
}
function ok(reply: Reply, path: string, status = 200): Record<string, unknown> {
	expect(reply.status, `${path}: ${JSON.stringify(reply.body)}`).toBe(status);
	return success(reply, path);
}
async function snapshot(host: HostFixture, sql: string, params: string[]): Promise<Record<string, unknown>[]> {
	const path = join(host.daemon.root, `proof-${randomUUID()}.db`);
	const source = new Database(join(host.daemon.workspace, "data/signet.db"), { readonly: true });
	try {
		source.query("VACUUM INTO ?").run(path);
	} finally {
		source.close();
	}
	const copy = new Database(path, { readonly: true });
	try {
		return copy
			.query(sql)
			.all(...params)
			.map(record);
	} finally {
		copy.close();
		await rm(path, { force: true });
	}
}
for (const signature of [
	"GET /api/connectors",
	"GET /api/connectors/:id",
	"GET /api/connectors/:id/health",
	"POST /api/connectors",
	"DELETE /api/connectors/:id",
	"POST /api/connectors/:id/sync",
	"POST /api/connectors/:id/sync/full",
	"POST /api/connectors/resync",
]) {
	proof(signature, async (host) => {
		const rootPath = join(host.daemon.root, `connector-${randomUUID()}`);
		await mkdir(rootPath);
		const registered = ok(
			await host.local("/api/connectors", "POST", {
				provider: "filesystem",
				displayName: "Host fixture",
				settings: { rootPath },
			}),
			"connector fixture registration",
			201,
		);
		const connectorId = text(registered.id);
		const [method, rawPath] = signature.split(" ");
		assert(method && rawPath);
		const path = rawPath.replace(":id", connectorId) + (rawPath.endsWith("/full") ? "?confirm=true" : "");
		try {
			if (signature === "POST /api/connectors") {
				const row = ok(await host.local(`/api/connectors/${connectorId}`), "registered connector readback");
				expect(record(JSON.parse(text(row.config_json))).settings).toEqual({ rootPath });
			} else {
				const result = ok(await host.local(path, method, method === "POST" ? {} : undefined), signature);
				if (signature === "GET /api/connectors")
					expect(rows(result.connectors).some((row) => row.id === connectorId)).toBe(true);
				else if (signature === "GET /api/connectors/:id") expect(result.id).toBe(connectorId);
				else if (signature.endsWith("/health")) {
					expect(result.id).toBe(connectorId);
					expect(result.documentCount).toBe(0);
				} else if (method === "DELETE") {
					expect(result.deleted).toBe(true);
					expect((await host.local(`/api/connectors/${connectorId}`)).status).toBe(404);
				} else {
					if (signature.endsWith("/resync")) {
						expect(result.started).toBe(1);
						expect(result.failed).toBe(0);
					} else expect(result.status).toBe("syncing");
					await until(async () => {
						const row = ok(await host.local(`/api/connectors/${connectorId}`), "connector sync readback");
						return row.status === "idle" && typeof row.last_sync_at === "string" && row.last_error === null;
					}, "connector scan completion and durable cursor");
				}
			}
		} finally {
			if (method !== "DELETE") ok(await host.local(`/api/connectors/${connectorId}`, "DELETE"), "connector undo");
			await rm(rootPath, { recursive: true });
		}
	});
}
proof("GET /api/harnesses", async (host) => {
	const value = ok(await host.local("/api/harnesses"), "harness inventory");
	expect(rows(value.connectors).some((row) => row.id === "codex")).toBe(true);
});
proof("GET /api/harnesses/:id/health", async (host) => {
	const value = ok(await host.local("/api/harnesses/codex/health"), "harness health");
	expect(value.id).toBe("codex");
	expect(value.available).toBe(true);
});
proof("POST /api/harnesses/regenerate", async (host) => {
	const input = join(host.daemon.home, ".agents");
	await mkdir(input, { recursive: true });
	await writeFile(join(input, "AGENTS.md"), "Host fixture instructions.\n");
	const value = ok(await host.local("/api/harnesses/regenerate", "POST", {}), "harness regeneration");
	expect(value.success).toBe(true);
	expect(await readFile(join(host.daemon.home, ".config/opencode/AGENTS.md"), "utf8")).toContain(
		"Host fixture instructions.",
	);
	await rm(join(host.daemon.home, ".config/opencode/AGENTS.md"));
});
for (const action of ["repair", "reinitialize"])
	proof(`POST /api/harnesses/:id/${action}`, async (host) => {
		const directory = join(host.daemon.home, ".codex");
		await mkdir(directory, { recursive: true });
		const config = join(directory, "config.toml");
		await writeFile(config, 'model = "host-fixture"\n');
		const value = ok(
			await host.local(`/api/harnesses/codex/${action}`, "POST", { confirm: true }),
			`harness ${action}`,
		);
		expect(value.success).toBe(true);
		expect(value.action).toBe(action);
		expect(await readFile(config, "utf8")).toContain("signet");
		const health = ok(await host.local("/api/harnesses/codex/health"), "harness repaired readback");
		expect(health.id).toBe("codex");
	});
proof("POST /api/config", async (host) => {
	const value = ok(
		await host.local("/api/config", "POST", { file: "host-fixture.md", content: "Host fixture configuration.\n" }),
		"config apply",
	);
	expect(value.success).toBe(true);
	expect(await readFile(join(host.daemon.workspace, "host-fixture.md"), "utf8")).toBe("Host fixture configuration.\n");
	await rm(join(host.daemon.workspace, "host-fixture.md"));
});
proof("GET /api/git/status", async (host) => {
	expect(ok(await host.local("/api/git/status"), "Git status").isRepo).toBe(true);
});
proof("GET /api/git/config", async (host) => {
	const config = ok(await host.local("/api/git/config"), "Git config");
	expect(config.remote).toBe("origin");
	expect(config.branch).toBe("main");
});
proof("POST /api/git/config", async (host) => {
	const original = ok(await host.local("/api/git/config"), "original Git config");
	const changed = ok(
		await host.local("/api/git/config", "POST", { syncInterval: 73, autoSync: false }),
		"Git config patch",
	);
	expect(changed.success).toBe(true);
	expect(ok(await host.local("/api/git/config"), "Git config readback").syncInterval).toBe(73);
	ok(await host.local("/api/git/config", "POST", original), "Git config undo");
});
proof("POST /api/git/pull", async (host) => {
	await writeFile(join(host.peer, "host-fixture.txt"), "pulled fixture\n");
	await host.command(["git", "add", "host-fixture.txt"], host.peer);
	await host.command(["git", "commit", "-m", "fixture remote change"], host.peer);
	await host.command(["git", "push", "origin", "main"], host.peer);
	const result = ok(await host.local("/api/git/pull", "POST", {}), "Git pull");
	expect(result.success, JSON.stringify(result)).toBe(true);
	expect(result.changes).toBe(1);
	expect(await readFile(join(host.daemon.workspace, "host-fixture.txt"), "utf8")).toBe("pulled fixture\n");
});
proof("POST /api/git/push", async (host) => {
	await writeFile(join(host.daemon.workspace, "host-fixture.txt"), "pushed fixture\n");
	await host.command(["git", "add", "host-fixture.txt"], host.daemon.workspace);
	await host.command(["git", "commit", "-m", "fixture local change"], host.daemon.workspace);
	const result = ok(await host.local("/api/git/push", "POST", {}), "Git push");
	expect(result.success, JSON.stringify(result)).toBe(true);
	expect(result.changes).toBe(1);
	expect(await host.command(["git", "--git-dir", host.upstream, "show", "main:host-fixture.txt"])).toBe(
		"pushed fixture\n",
	);
});
proof("POST /api/git/sync", async (host) => {
	await writeFile(join(host.daemon.workspace, "host-fixture.txt"), "synced fixture\n");
	await host.command(["git", "add", "host-fixture.txt"], host.daemon.workspace);
	await host.command(["git", "commit", "-m", "fixture sync change"], host.daemon.workspace);
	const result = ok(await host.local("/api/git/sync", "POST", {}), "Git sync");
	expect(result.success, JSON.stringify(result)).toBe(true);
	expect(result.pushed).toBe(1);
	expect(await host.command(["git", "--git-dir", host.upstream, "show", "main:host-fixture.txt"])).toBe(
		"synced fixture\n",
	);
});
proof("POST /api/memory/codex-native-note", async (host) => {
	const result = ok(
		await host.local("/api/memory/codex-native-note", "POST", {
			content: "Host fixture native note.",
			title: "Host fixture",
		}),
		"native note",
	);
	const path = text(result.path);
	expect(path.startsWith(host.daemon.home)).toBe(true);
	expect(await readFile(path, "utf8")).toContain("Host fixture native note.");
	await rm(path);
});
export async function sourceBody(host: HostFixture, kind: string): Promise<Record<string, unknown>> {
	if (kind === "github")
		return {
			agentId: "default",
			repo: "fixture/repo",
			tokenRef: "HOST_GITHUB",
			resourceTypes: ["issues"],
			includeComments: false,
			maxItemsPerRepo: 1,
		};
	if (kind === "discord")
		return {
			agentId: "default",
			guildId: "123456789012345678",
			tokenRef: "HOST_DISCORD",
			channelFilter: ["456789012345678901"],
			includeThreads: false,
			includeMembers: false,
			maxMessagesPerChannel: 1,
		};
	const root = join(host.daemon.root, "obsidian");
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "fixture.md"), "Host fixture Obsidian evidence.\n");
	return { root, agentId: "default", name: "Host fixture vault" };
}
for (const kind of ["obsidian", "github", "discord"])
	proof(`POST /api/sources/${kind}`, async (host) => {
		const result = ok(
			await host.local(`/api/sources/${kind}`, "POST", await sourceBody(host, kind)),
			`source ${kind}`,
			202,
		);
		const source = record(result.source);
		const sourceId = text(source.id);
		expect(source.kind).toBe(kind);
		expect(source.agentId).toBe("default");
		expect(result.created).toBe(true);
		const list = ok(await host.local("/api/sources?agentId=default"), "source readback");
		expect(rows(list.sources).some((row) => row.id === sourceId)).toBe(true);
		await until(async () => {
			const health = ok(await host.local(`/api/sources/${sourceId}/health?agentId=default`), "source health");
			return Number(record(health.stats).artifacts) > 0 || Number(record(health.stats).artifactCount) > 0;
		}, `${kind} indexed durable artifact`);
		ok(await host.local(`/api/sources/${sourceId}`, "DELETE"), `source ${kind} undo`);
		expect(
			rows(ok(await host.local("/api/sources?agentId=default"), "source deletion readback").sources).some(
				(row) => row.id === sourceId,
			),
		).toBe(false);
	});
async function hookTranscript(
	host: HostFixture,
	name: string,
): Promise<{ sessionKey: string; transcriptPath: string; toolId: string }> {
	const sessionKey = `host-gap-${name}-${randomUUID()}`;
	const toolId = randomUUID();
	const transcriptPath = join(host.daemon.root, `${sessionKey}.jsonl`);
	await writeFile(
		transcriptPath,
		[
			{ type: "user", sessionId: sessionKey, message: { role: "user", content: `Host fixture prompt ${name}.` } },
			{
				type: "assistant",
				sessionId: sessionKey,
				timestamp: "2026-01-01T00:00:00Z",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: toolId, name: "Skill", input: { skill: "host-fixture" } }],
				},
			},
			{
				type: "user",
				sessionId: sessionKey,
				timestamp: "2026-01-01T00:00:01Z",
				message: { content: [{ type: "tool_result", tool_use_id: toolId, is_error: false }] },
			},
			{
				type: "assistant",
				sessionId: sessionKey,
				message: { role: "assistant", content: `Host fixture answer ${name}.` },
			},
		]
			.map((row) => JSON.stringify(row))
			.join("\n"),
	);
	ok(
		await host.local("/api/hooks/session-start", "POST", { harness: "claude-code", agentId: "default", sessionKey }),
		"hook fixture session start",
	);
	return { sessionKey, transcriptPath, toolId };
}
for (const name of ["pre-compaction", "user-prompt-submit", "session-end", "session-checkpoint-extract"])
	proof(`POST /api/hooks/${name}`, async (host) => {
		const hook = await hookTranscript(host, name);
		const configPath = join(host.daemon.workspace, "agent.yaml");
		const config = await readFile(configPath, "utf8");
		if (name === "session-checkpoint-extract")
			ok(
				await host.local("/api/config", "POST", {
					file: "agent.yaml",
					content: config.replace("pipelineV2:\n    enabled: false", "pipelineV2:\n    enabled: true"),
				}),
				"enable checkpoint capture",
			);
		try {
			const result = ok(
				await host.local(`/api/hooks/${name}`, "POST", {
					harness: "claude-code",
					agentId: "default",
					sessionKey: hook.sessionKey,
					transcriptPath: hook.transcriptPath,
					userMessage: "Host fixture inline prompt.",
					reason: "session_shutdown",
				}),
				`hook ${name}`,
			);
			if (name === "pre-compaction") {
				expect(text(result.summaryPrompt).length).toBeGreaterThan(0);
				await until(
					async () =>
						(await snapshot(host, "SELECT agent_id FROM skill_invocations WHERE tool_use_id = ?", [hook.toolId])).some(
							(row) => row.agent_id === "default",
						),
					"durable scanned skill invocation",
				);
			} else {
				await until(async () => {
					const transcript = await host.local(`/api/sessions/${hook.sessionKey}/transcript?agent_id=default`);
					return (
						transcript.status === 200 &&
						JSON.stringify(transcript.body).includes(
							name === "user-prompt-submit" ? "Host fixture inline prompt." : `Host fixture prompt ${name}.`,
						)
					);
				}, `durable ${name} transcript`);
			}
		} finally {
			if (name === "session-checkpoint-extract")
				ok(
					await host.local("/api/config", "POST", { file: "agent.yaml", content: config }),
					"restore checkpoint configuration",
				);
			await host.local(`/api/sessions/${hook.sessionKey}/transcript?agent_id=default`, "DELETE");
			await rm(hook.transcriptPath);
		}
	});
for (const path of [
	"/api/plugins",
	"/api/plugins/signet.secrets",
	"/api/plugins/signet.secrets/diagnostics",
	"/api/plugins/audit",
	"/api/plugins/prompt-contributions",
]) {
	const signature = path.endsWith("/diagnostics")
		? "GET /api/plugins/:id/diagnostics"
		: path === "/api/plugins/signet.secrets"
			? "GET /api/plugins/:id"
			: `GET ${path}`;
	proof(signature, async (host) => {
		if (path.endsWith("/audit")) {
			const original = ok(await host.local("/api/plugins/signet.graphiq"), "audit fixture plugin");
			try {
				ok(await host.local("/api/plugins/signet.graphiq", "PATCH", { enabled: true }), "audit fixture event");
				const audit = ok(
					await host.local(`${path}?pluginId=signet.graphiq&event=plugin.enabled`),
					"durable plugin audit readback",
				);
				expect(
					rows(audit.events).some((event) => event.pluginId === "signet.graphiq" && event.event === "plugin.enabled"),
				).toBe(true);
			} finally {
				ok(
					await host.local("/api/plugins/signet.graphiq", "PATCH", { enabled: original.enabled }),
					"audit fixture undo",
				);
			}
			return;
		}
		const value = ok(await host.local(path), path);
		if (path === "/api/plugins") expect(rows(value.plugins).some((row) => row.id === "signet.secrets")).toBe(true);
		else if (path.endsWith("/diagnostics")) expect(record(record(value.plugin).record).id).toBe("signet.secrets");
		else if (path.endsWith("/prompt-contributions")) {
			expect(rows(value.contributions).length).toBe(Number(value.activeCount));
			expect(Number(value.activeCount)).toBeGreaterThan(0);
		} else expect(value.id).toBe("signet.secrets");
	});
}
proof("PATCH /api/plugins/:id", async (host) => {
	const original = ok(await host.local("/api/plugins/signet.graphiq"), "original plugin");
	ok(await host.local("/api/plugins/signet.graphiq", "PATCH", { enabled: true }), "enable plugin");
	expect(ok(await host.local("/api/plugins/signet.graphiq"), "plugin readback").enabled).toBe(true);
	ok(await host.local("/api/plugins/signet.graphiq", "PATCH", { enabled: original.enabled }), "plugin undo");
});
proof("POST /api/graphiq/update", async (host) => {
	const result = ok(await host.local("/api/graphiq/update", "POST", {}), "GraphIQ update");
	expect(result.success, JSON.stringify(result)).toBe(true);
	const binary = join(host.daemon.home, ".local/bin/graphiq");
	expect(await readFile(binary, "utf8")).toContain("host-fixture-graphiq");
	expect(host.externalCalls.some((call) => call.includes("/releases/download/"))).toBe(true);
});
async function connect(host: HostFixture, provider: "1password" | "bitwarden"): Promise<void> {
	const value = randomBytes(24).toString("base64url");
	ok(
		await host.local(
			`/api/secrets/${provider}/connect`,
			"POST",
			provider === "1password" ? { token: value } : { session: value },
		),
		`connect ${provider}`,
	);
}
for (const provider of ["1password", "bitwarden"] as const) {
	proof(`GET /api/secrets/${provider}/status`, async (host) => {
		await connect(host, provider);
		const value = ok(await host.local(`/api/secrets/${provider}/status`), `${provider} status`);
		expect(value.configured).toBe(true);
		expect(value.connected).toBe(true);
	});
	const resource = provider === "1password" ? "vaults" : "folders";
	proof(`GET /api/secrets/${provider}/${resource}`, async (host) => {
		await connect(host, provider);
		const value = ok(await host.local(`/api/secrets/${provider}/${resource}`), `${provider} ${resource}`);
		expect(rows(value[resource]).map((row) => row.id)).toEqual([
			provider === "1password" ? "fixture-vault" : "fixture-folder",
		]);
	});
	proof(`POST /api/secrets/${provider}/connect`, async (host) => {
		await connect(host, provider);
		expect(ok(await host.local(`/api/secrets/${provider}/status`), "provider readback").connected).toBe(true);
	});
	proof(`DELETE /api/secrets/${provider}/connect`, async (host) => {
		await connect(host, provider);
		const value = ok(await host.local(`/api/secrets/${provider}/connect`, "DELETE"), `disconnect ${provider}`);
		expect(value.success).toBe(true);
		expect(ok(await host.local(`/api/secrets/${provider}/status`), "provider deletion readback").configured).toBe(
			false,
		);
	});
}
proof("POST /api/secrets/1password/import", async (host) => {
	await connect(host, "1password");
	const value = ok(
		await host.local("/api/secrets/1password/import", "POST", { prefix: "HOSTIMPORT", overwrite: true }),
		"1Password import",
	);
	expect(value.importedCount).toBe(1);
	expect(value.errorCount).toBe(0);
	const names = ok(await host.local("/api/secrets"), "imported secret names").secrets;
	expect(Array.isArray(names) && names.includes("HOSTIMPORT_FIXTURE_SERVICE_PASSWORD")).toBe(true);
	ok(await host.local("/api/secrets/HOSTIMPORT_FIXTURE_SERVICE_PASSWORD", "DELETE"), "import undo");
});
proof("POST /api/secrets/bitwarden/migrate", async (host) => {
	await connect(host, "bitwarden");
	ok(
		await host.local("/api/secrets/HOST_MIGRATE", "POST", { value: randomBytes(24).toString("base64url") }),
		"migration input",
	);
	const value = ok(
		await host.local("/api/secrets/bitwarden/migrate", "POST", {
			dryRun: false,
			overwrite: true,
			folderId: "fixture-folder",
		}),
		"Bitwarden migration",
	);
	expect(Number(value.migratedCount)).toBeGreaterThan(0);
	expect(value.errorCount).toBe(0);
	expect(
		rows(JSON.parse(await readFile(join(host.daemon.root, "bitwarden.json"), "utf8"))).some(
			(item) => item.name === "HOST_MIGRATE" && typeof record(item.login).password === "string",
		),
	).toBe(true);
	ok(await host.local("/api/secrets/HOST_MIGRATE", "DELETE"), "migration input undo");
});
proof("POST /api/secrets/bitwarden/provider", async (host) => {
	await connect(host, "bitwarden");
	ok(await host.local("/api/secrets/bitwarden/provider", "POST", { provider: "bitwarden" }), "activate Bitwarden");
	expect(ok(await host.local("/api/secrets/bitwarden/status"), "provider readback").activeProvider).toBe(true);
	ok(await host.local("/api/secrets/bitwarden/provider", "POST", { provider: "local" }), "provider undo");
	expect(ok(await host.local("/api/secrets/bitwarden/status"), "provider undo readback").activeProvider).toBe(false);
});
for (const path of [
	"/api/inference/status",
	"/api/inference/catalog",
	"/api/assistant/models",
	"/v1/models",
	"/api/inference/history",
	"/api/inference/oauth/providers",
])
	proof(`GET ${path}`, async (host) => {
		const value = ok(await host.local(path), path);
		if (path.endsWith("/history")) expect(Array.isArray(value.events)).toBe(true);
		else if (path === "/api/assistant/models")
			expect(
				rows(value.models).some(
					(model) => model.targetRef === "local/default" && model.model === "llama-3.3-70b-versatile",
				),
			).toBe(true);
		else if (path.endsWith("/providers"))
			expect(rows(value.providers).some((provider) => provider.id === "org-host-fixture")).toBe(true);
		else expect(JSON.stringify(value)).toContain("host-fixture");
	});
proof("POST /api/inference/execute", async (host) => {
	const value = ok(
		await host.local("/api/inference/execute", "POST", { agentId: "default", prompt: "Host fixture prompt." }),
		"inference execute",
	);
	expect(value.text).toBe(fixtureAnswer);
	expect(host.externalCalls).toContain("POST /v1/chat/completions");
});
proof("POST /api/inference/explain", async (host) => {
	const value = ok(
		await host.local("/api/inference/explain", "POST", { agentId: "default", promptPreview: "Host fixture prompt." }),
		"inference explain",
	);
	expect(JSON.stringify(value)).toContain("local/default");
});
proof("POST /api/inference/stream", async (host) => {
	const response = await host.raw("/api/inference/stream", "POST", {
		agentId: "default",
		prompt: "Host fixture prompt.",
	});
	expect(response.status, response.status === 200 ? "" : await response.text()).toBe(200);
	const events = eventRows(await response.text());
	expect(events.some((row) => row.text === fixtureAnswer)).toBe(true);
	expect(events.some((row) => row.type === "error" || typeof row.error === "string")).toBe(false);
});
proof("POST /v1/chat/completions", async (host) => {
	const value = ok(
		await host.local("/v1/chat/completions", "POST", {
			model: "local/default",
			agentId: "default",
			messages: [{ role: "user", content: "Host fixture prompt." }],
		}),
		"gateway chat",
	);
	expect(record(rows(value.choices)[0]?.message).content).toBe(fixtureAnswer);
});
proof("POST /api/assistant/chat", async (host) => {
	const response = await host.raw("/api/assistant/chat", "POST", {
		requestId: randomUUID(),
		conversationId: randomUUID(),
		agentId: "default",
		modelSelection: { targetRef: "local/default", model: "llama-3.3-70b-versatile" },
		messages: [{ role: "user", content: "Reply briefly without calling tools." }],
	});
	expect(response.status, response.status === 200 ? "" : await response.text()).toBe(200);
	const events = eventRows(await response.text());
	expect(
		events.some((row) => row.type === "delta" && row.text === fixtureAnswer),
		JSON.stringify(events),
	).toBe(true);
	expect(events.some((row) => row.type === "done")).toBe(true);
	expect(events.some((row) => row.type === "error")).toBe(false);
});
proof("DELETE /api/inference/requests/:id", async (host) => {
	const response = await host.raw("/api/inference/stream", "POST", { agentId: "default", prompt: "host-gap-hold" });
	expect(response.status, response.status === 200 ? "" : await response.text()).toBe(200);
	const requestId = response.headers.get("x-signet-request-id");
	assert(requestId);
	const reader = response.body?.getReader();
	assert(reader);
	try {
		const first = await reader.read();
		expect(first.done).toBe(false);
		const result = ok(await host.local(`/api/inference/requests/${requestId}`, "DELETE"), "cancel inference");
		expect(result.ok).toBe(true);
		expect(result.requestId).toBe(requestId);
		expect((await host.local(`/api/inference/requests/${requestId}`, "DELETE")).status).toBe(404);
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
});
async function oauth(host: HostFixture): Promise<void> {
	const response = await host.raw("/api/inference/oauth/login/org-host-fixture", "POST", {});
	expect(response.status, response.status === 200 ? "" : await response.text()).toBe(200);
	const sessionId = response.headers.get("x-signet-oauth-session-id");
	assert(sessionId);
	const reader = response.body?.getReader();
	assert(reader);
	let all = "";
	const decoder = new TextDecoder();
	try {
		let responseId: string | undefined;
		while (!responseId) {
			const part = await reader.read();
			assert(!part.done);
			all += decoder.decode(part.value, { stream: true });
			responseId = eventRows(all)
				.find((event) => event.type === "prompt")
				?.responseId?.toString();
		}
		ok(
			await host.local("/api/inference/oauth/complete", "POST", { sessionId, responseId, value: "fixture-account" }),
			"OAuth completion",
		);
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			all += decoder.decode(part.value, { stream: true });
		}
		expect(eventRows(all).some((event) => event.type === "connected")).toBe(true);
		expect(
			rows(ok(await host.local("/api/inference/oauth/providers"), "OAuth credential readback").providers).find(
				(provider) => provider.id === "org-host-fixture",
			)?.connected,
		).toBe(true);
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}
proof("POST /api/inference/oauth/login/:id", oauth);
proof("POST /api/inference/oauth/complete", oauth);
proof("POST /api/inference/oauth/disconnect/:id", async (host) => {
	await oauth(host);
	const value = ok(
		await host.local("/api/inference/oauth/disconnect/org-host-fixture", "POST", {}),
		"OAuth disconnect",
	);
	expect(value.disconnected).toBe(true);
	expect(
		rows(ok(await host.local("/api/inference/oauth/providers"), "OAuth deletion readback").providers).find(
			(provider) => provider.id === "org-host-fixture",
		)?.connected,
	).toBe(false);
});
export const hostGapCases: readonly GapCase[] = cases;

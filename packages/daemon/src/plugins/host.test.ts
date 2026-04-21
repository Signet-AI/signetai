import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { countTokens } from "../pipeline/tokenizer.js";
import { SIGNET_SECRETS_PLUGIN_ID, signetSecretsManifest } from "./bundled/secrets.js";
import { PluginHostV1 } from "./host.js";
import type { PluginManifestV1 } from "./types.js";

function makeHost(): PluginHostV1 {
	return new PluginHostV1({
		storagePath: null,
		auditPath: null,
		corePluginIds: [SIGNET_SECRETS_PLUGIN_ID, "signet.rust-example"],
		now: () => new Date("2026-04-16T12:00:00.000Z"),
	});
}

let root = "";

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function makeStoragePath(): string {
	root = mkdtempSync(join(tmpdir(), "signet-plugin-host-"));
	return join(root, "registry-v1.json");
}

describe("PluginHostV1", () => {
	test("discovers bundled signet.secrets idempotently with active surfaces", () => {
		const host = makeHost();
		host.discover(signetSecretsManifest, { grantedCapabilities: signetSecretsManifest.capabilities });
		host.discover(signetSecretsManifest, { grantedCapabilities: signetSecretsManifest.capabilities });

		const plugins = host.list();
		expect(plugins).toHaveLength(1);
		expect(plugins[0]?.id).toBe(SIGNET_SECRETS_PLUGIN_ID);
		expect(plugins[0]?.state).toBe("active");
		expect(plugins[0]?.grantedCapabilities).toContain("secrets:exec");
		expect(plugins[0]?.surfaces.mcpTools.map((tool) => tool.name)).toContain("secret_exec");
	});

	test("disabling signet.secrets removes active prompt contributions", () => {
		const host = makeHost();
		host.discover(signetSecretsManifest, { grantedCapabilities: signetSecretsManifest.capabilities });
		expect(host.promptContributions().map((entry) => entry.id)).toEqual(["signet.secrets.credential-guidance"]);

		const disabled = host.setEnabled(SIGNET_SECRETS_PLUGIN_ID, false);
		expect(disabled?.state).toBe("disabled");
		expect(host.promptContributions()).toEqual([]);
		expect(host.diagnostics(SIGNET_SECRETS_PLUGIN_ID)?.promptContributions).toHaveLength(1);
		expect(host.diagnostics(SIGNET_SECRETS_PLUGIN_ID)?.promptContributionDiagnostics[0]?.included).toBe(false);
		expect(host.checkCapabilities(SIGNET_SECRETS_PLUGIN_ID, ["secrets:list"]).status).toBe("plugin-inactive");
	});

	test("filters active surfaces and prompt contributions by granted capabilities", () => {
		const host = makeHost();
		host.discover(signetSecretsManifest, {
			grantedCapabilities: ["cli:command", "secrets:list", "sdk:client"],
		});

		const record = host.get(SIGNET_SECRETS_PLUGIN_ID);
		expect(record?.surfaces.daemonRoutes.map((route) => route.path)).toEqual(["/api/secrets"]);
		expect(record?.surfaces.cliCommands.map((command) => command.path.join(" "))).toEqual(["secret list"]);
		expect(record?.surfaces.sdkClients.map((client) => client.name)).toEqual(["listSecrets"]);
		expect(record?.surfaces.promptContributions).toEqual([]);
		expect(host.promptContributions()).toEqual([]);

		const diagnostics = host.diagnostics(SIGNET_SECRETS_PLUGIN_ID);
		expect(diagnostics?.promptContributionDiagnostics[0]?.included).toBe(false);
		expect(diagnostics?.promptContributionDiagnostics[0]?.missingCapabilities).toEqual([
			"prompt:contribute:user-prompt-submit",
		]);
		expect(host.checkCapabilities(SIGNET_SECRETS_PLUGIN_ID, ["secrets:write"]).status).toBe("capability-missing");
	});

	test("preserves explicit empty persisted grants during discovery", () => {
		const path = makeStoragePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				plugins: {
					[SIGNET_SECRETS_PLUGIN_ID]: {
						enabled: true,
						grantedCapabilities: [],
						installedAt: "2026-04-01T00:00:00.000Z",
						updatedAt: "2026-04-01T00:00:00.000Z",
					},
				},
			}),
		);

		const host = new PluginHostV1({
			storagePath: path,
			auditPath: null,
			corePluginIds: [SIGNET_SECRETS_PLUGIN_ID],
			now: () => new Date("2026-04-16T12:00:00.000Z"),
		});
		const record = host.discover(signetSecretsManifest, {
			grantedCapabilities: signetSecretsManifest.capabilities,
		});

		expect(record.grantedCapabilities).toEqual([]);
		expect(record.pendingCapabilities).toEqual(signetSecretsManifest.capabilities);
		const registry = JSON.parse(readFileSync(path, "utf-8"));
		expect(registry.plugins[SIGNET_SECRETS_PLUGIN_ID].grantedCapabilities).toEqual([]);
	});

	test("clips prompt contribution content to maxTokens budget", () => {
		const host = makeHost();
		const content = "😀😀😀😀 ascii tail should be clipped";
		host.discover({
			...signetSecretsManifest,
			surfaces: {
				...signetSecretsManifest.surfaces,
				promptContributions: [
					{
						id: "signet.secrets.credential-guidance",
						target: "user-prompt-submit",
						mode: "context",
						priority: 420,
						maxTokens: 2,
						summary: "Tiny prompt budget",
						requiredCapabilities: ["prompt:contribute:user-prompt-submit"],
					},
				],
			},
			promptContributions: [
				{
					id: "signet.secrets.credential-guidance",
					pluginId: SIGNET_SECRETS_PLUGIN_ID,
					target: "user-prompt-submit",
					mode: "context",
					priority: 420,
					maxTokens: 2,
					content,
				},
			],
		});

		const contribution = host.promptContributions()[0];
		expect(contribution?.content).not.toBe(content);
		expect(countTokens(contribution?.content ?? "")).toBeLessThanOrEqual(2);
	});

	test("unsupported Rust sidecar manifests are blocked in V1", () => {
		const host = makeHost();
		const manifest: PluginManifestV1 = {
			...signetSecretsManifest,
			id: "signet.rust-example",
			name: "Rust Example",
			runtime: {
				language: "rust",
				kind: "sidecar",
				protocol: "signet-plugin-rpc@1",
			},
			surfaces: {
				...signetSecretsManifest.surfaces,
				promptContributions: [],
			},
			promptContributions: [],
		};

		const record = host.discover(manifest, { source: "bundled" });
		expect(record.state).toBe("blocked");
		expect(record.stateReason).toContain("unsupported runtime in plugin API V1");
		expect(record.grantedCapabilities).toEqual([]);
	});

	test("blocks stale persisted grants for unsupported manifests", () => {
		const host = makeHost();
		host.discover(signetSecretsManifest, { grantedCapabilities: signetSecretsManifest.capabilities });

		const manifest: PluginManifestV1 = {
			...signetSecretsManifest,
			runtime: {
				language: "rust",
				kind: "sidecar",
				protocol: "signet-plugin-rpc@1",
			},
		};

		const record = host.discover(manifest);
		expect(record.state).toBe("blocked");
		expect(record.grantedCapabilities).toEqual([]);
		expect(record.pendingCapabilities).toEqual(signetSecretsManifest.capabilities);
	});

	test("does not overwrite malformed registry files during discovery", () => {
		const path = makeStoragePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{not-json");

		const host = new PluginHostV1({
			storagePath: path,
			auditPath: null,
			corePluginIds: [SIGNET_SECRETS_PLUGIN_ID],
			now: () => new Date("2026-04-16T12:00:00.000Z"),
		});
		host.discover(signetSecretsManifest, { grantedCapabilities: signetSecretsManifest.capabilities });

		expect(readFileSync(path, "utf-8")).toBe("{not-json");
	});

	test("preserves unknown registry entry metadata when rediscovering plugins", () => {
		const path = makeStoragePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				plugins: {
					[SIGNET_SECRETS_PLUGIN_ID]: {
						enabled: true,
						grantedCapabilities: signetSecretsManifest.capabilities,
						installedAt: "2026-04-01T00:00:00.000Z",
						updatedAt: "2026-04-01T00:00:00.000Z",
						providerMetadata: { source: "future-provider" },
					},
				},
			}),
		);

		const host = new PluginHostV1({
			storagePath: path,
			auditPath: null,
			corePluginIds: [SIGNET_SECRETS_PLUGIN_ID],
			now: () => new Date("2026-04-16T12:00:00.000Z"),
		});
		host.discover(signetSecretsManifest);

		const registry = JSON.parse(readFileSync(path, "utf-8"));
		expect(registry.plugins[SIGNET_SECRETS_PLUGIN_ID].providerMetadata).toEqual({
			source: "future-provider",
		});
	});
});

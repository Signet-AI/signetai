import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { parseSimpleYaml, resolveWorkspaceLayout } from "@signet/core";
import { SignetTransport, SignetError } from "../../../../libs/sdk/src/index.js";
import { readKeyFile } from "../../../../libs/sdk/src/node.js";
import { runDashboardSetupBootstrap } from "./setup-fresh.js";
import type { SetupDeps, SetupWizardOptions } from "./setup-types.js";
import { assertHostPortAvailable, resolveHostOrigin } from "../lib/host-target.js";

export async function setupOrganizationHost(
	options: SetupWizardOptions,
	deps: Pick<SetupDeps, "AGENTS_DIR" | "DEFAULT_PORT" | "normalizeAgentPath" | "getTemplatesDir" | "startDaemon">,
) {
	const origin = resolveHostOrigin(options.port, process.env, deps.DEFAULT_PORT);
	const url = new URL(options.publicUrl ?? origin);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
	)
		throw new SignetError(
			"Public URL must be an HTTPS origin (HTTP is allowed only for loopback)",
			"invalid_public_url",
		);
	if (
		options.harness?.length ||
		options.file ||
		options.json ||
		options.embeddingProvider ||
		options.extractionProvider
	)
		throw new SignetError(
			"Configure organization providers after claiming the instance; do not pass personal-workspace setup options",
			"invalid_host_options",
		);
	const basePath = deps.normalizeAgentPath(options.path ?? deps.AGENTS_DIR);
	if (options.dryRun) {
		console.log(
			JSON.stringify({ host: true, path: basePath, origin, publicUrl: url.origin, mode: "team", dryRun: true }),
		);
		return;
	}
	await assertHostPortAvailable(origin);
	const local = new SignetTransport({
		baseUrl: origin,
		retries: 0,
		timeoutMs: 2000,
	});

	let exists = false;
	try {
		await access(join(basePath, "agent.yaml"));
		exists = true;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (exists) {
		const source = await readFile(join(basePath, "agent.yaml"), "utf8");
		const config = parseSimpleYaml(source);
		if (
			typeof config.auth !== "object" ||
			config.auth === null ||
			!("mode" in config.auth) ||
			config.auth.mode !== "team"
		)
			throw new SignetError(
				"Refusing to convert an existing personal workspace to an organization",
				"workspace_exists",
			);
	} else {
		await runDashboardSetupBootstrap(
			basePath,
			{
				allowUnprotectedWorkspace: options.allowUnprotectedWorkspace === true,
				createLocalBackup: options.createLocalBackup === true,
				organization: true,
			},
			deps,
		);
	}
	if (!(await deps.startDaemon(basePath, undefined, undefined, { origin })))
		throw new SignetError(
			"Organization workspace created, but daemon startup failed; fix startup and rerun --host",
			"daemon_start_failed",
		);
	const launchedPid = Number((await readFile(join(resolveWorkspaceLayout(basePath).runtime, "pid"), "utf8")).trim());
	const health = await local.get<{ agentsDir: string; pid: number }>("/health");
	if (
		!Number.isSafeInteger(launchedPid) ||
		launchedPid <= 0 ||
		health.pid !== launchedPid ||
		health.agentsDir !== basePath
	)
		throw new SignetError("Daemon readiness belongs to another workspace", "workspace_conflict");
	const setupToken = await readKeyFile(join(resolveWorkspaceLayout(basePath).runtime, "setup-token"));
	const publicClient = new SignetTransport({ baseUrl: url.origin, retries: 0, timeoutMs: 10_000 });
	const prepared = await publicClient.post<{ prepared: boolean; publicUrl: string }>("/api/org/bootstrap", {
		setupToken,
		publicUrl: url.origin,
	});
	if (!prepared.prepared || prepared.publicUrl !== url.origin)
		throw new SignetError("Public URL did not confirm this instance's setup nonce", "public_url_unverified");
	console.error(
		"This instance uses team authentication. Do not deploy hybrid mode behind an untrusted reverse proxy. Configure providers and sources after claiming; no server harnesses were installed.",
	);
	console.log(`Daemon: ${origin}\nSetup URL: ${url.origin}/auth/setup\nOne-time setup token: ${setupToken}`);
}

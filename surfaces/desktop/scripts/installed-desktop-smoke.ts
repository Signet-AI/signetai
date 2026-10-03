import { launchSmokeProcess as launch } from "./smoke-process";
import { createServer } from "node:http";
import { existsSync, realpathSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function smokeEnvironment(home: string, workspace: string): Record<string, string> {
	const environment: Record<string, string> = {
		HOME: home,
		USERPROFILE: home,
		APPDATA: join(home, "AppData", "Roaming"),
		LOCALAPPDATA: join(home, "AppData", "Local"),
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_RUNTIME_DIR: join(home, "run"),
		TMPDIR: join(home, "tmp"),
		TEMP: join(home, "tmp"),
		TMP: join(home, "tmp"),
		LANG: "C",
		PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin:/usr/sbin:/sbin",
		SIGNET_PATH: workspace,
		SIGNET_HOST: "127.0.0.1",
		SIGNET_DAEMON_RUNTIME: "bun-js",
		SIGNET_TELEMETRY_DISABLED: "1",
	};
	if (process.platform === "win32") {
		const system = process.env.SystemRoot;
		if (!system || !existsSync(system)) throw new Error("Missing Windows system directory");
		environment.SystemRoot = system;
		environment.WINDIR = system;
	}
	const bus = process.env.SIGNET_SMOKE_DBUS_ADDRESS;
	if (bus) environment.DBUS_SESSION_BUS_ADDRESS = bus;
	return environment;
}

async function bounded(
	command: string,
	args: readonly string[],
	cwd: string,
	env: Record<string, string>,
): Promise<string> {
	const process = launch(command, args, cwd, env);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("Installed runtime command timed out")), 60_000);
	});
	try {
		const code = await Promise.race([process.done, timeout]);
		if (code !== 0) throw new Error(`Installed runtime command failed (${code}): ${process.output()}`);
		return process.output();
	} finally {
		clearTimeout(timer);
		await process.stop();
	}
}

async function main(): Promise<void> {
	const argument = process.argv.indexOf("--resources-root");
	const supplied = process.argv[argument + 1];
	if (argument < 0 || !supplied)
		throw new Error("Usage: installed-desktop-smoke.ts --resources-root <installed resources directory>");
	const resources = realpathSync(resolve(supplied));
	let ancestor = resolve(resources, "..");
	while (true) {
		if (existsSync(join(ancestor, ".git")) || existsSync(join(ancestor, "node_modules")))
			throw new Error(`Installed smoke must not borrow a checkout or ancestor node_modules: ${ancestor}`);
		const parent = resolve(ancestor, "..");
		if (parent === ancestor) break;
		ancestor = parent;
	}
	const bun = join(resources, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
	const daemon = join(resources, "daemon", "dist", "daemon.js");
	const diagnostics = join(resources, "daemon", "dist", "runtime-diagnostics.js");
	for (const path of [bun, daemon, diagnostics])
		if (!existsSync(path)) throw new Error(`Missing installed runtime asset: ${path}`);
	const root = mkdtempSync(join(tmpdir(), "signet-installed-smoke-"));
	const home = join(root, "home");
	const workspace = join(home, ".agents");
	mkdirSync(workspace, { recursive: true });
	const env = smokeEnvironment(home, workspace);
	mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
	mkdirSync(env.TMPDIR, { recursive: true });
	const nonce = `installed-smoke-${crypto.randomUUID()}`;
	let calls = 0;
	const stub = createServer(async (request, response) => {
		response.setHeader("content-type", "application/json");
		if (request.url?.endsWith("/models")) {
			response.end(JSON.stringify({ data: [{ id: "installed-smoke" }] }));
			return;
		}
		let body = "";
		for await (const chunk of request) body += String(chunk);
		if (!body.includes(nonce) || !request.url?.endsWith("/chat/completions")) {
			response.writeHead(400);
			response.end();
			return;
		}
		calls++;
		response.setHeader("content-type", "text/event-stream");
		const chunk = { id: "smoke", object: "chat.completion.chunk", created: 0, model: "installed-smoke" };
		response.write(
			`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: nonce }, finish_reason: null }] })}\n\n`,
		);
		response.write(
			`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((accept) => stub.listen(0, "127.0.0.1", accept));
	const stubAddress = stub.address();
	if (!stubAddress || typeof stubAddress === "string") throw new Error("Missing provider stub address");
	const reservation = createServer();
	await new Promise<void>((accept) => reservation.listen(0, "127.0.0.1", accept));
	const address = reservation.address();
	if (!address || typeof address === "string") throw new Error("Missing daemon port");
	await new Promise<void>((accept, reject) => reservation.close((error) => (error ? reject(error) : accept())));
	env.SIGNET_PORT = String(address.port);
	env.SIGNET_DAEMON_URL = `http://127.0.0.1:${address.port}`;
	const config = {
		configVersion: 9,
		auth: { mode: "local" },
		memory: { pipelineV2: { enabled: false } },
		inference: {
			defaultPolicy: "installed",
			targets: {
				installed: {
					executor: "openai-compatible",
					endpoint: `http://127.0.0.1:${stubAddress.port}/v1`,
					models: { default: { model: "installed-smoke" } },
				},
			},
			policies: { installed: { mode: "strict", defaultTargets: ["installed/default"] } },
			workloads: { interactive: { policy: "installed" } },
		},
	};
	writeFileSync(
		join(workspace, "agent.yaml"),
		`${Object.entries(config)
			.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
			.join("\n")}\n`,
	);
	await bounded(
		bun,
		[
			"-e",
			'import { Database } from "bun:sqlite"; import { mkdirSync } from "node:fs"; import { join } from "node:path"; const memory = join(process.env.SIGNET_PATH, "memory"); mkdirSync(memory, { recursive: true }); new Database(join(memory, "memories.db"), { create: true }).close();',
		],
		root,
		env,
	);
	const running = launch(bun, [daemon], root, env);
	let report = "";
	try {
		const deadline = Date.now() + 90_000;
		let ready = false;
		while (Date.now() < deadline && running.child.exitCode === null) {
			try {
				const response = await fetch(`${env.SIGNET_DAEMON_URL}/health`, { signal: AbortSignal.timeout(2000) });
				const health: unknown = await response.json();
				ready =
					response.ok &&
					health !== null &&
					typeof health === "object" &&
					Reflect.get(health, "pid") === running.child.pid &&
					Reflect.get(health, "db") === true;
			} catch {}
			if (ready) break;
			await new Promise((accept) => setTimeout(accept, 200));
		}
		if (!ready) throw new Error(`Installed daemon did not become ready: ${running.output()}`);
		const runtime = await bounded(bun, [diagnostics], root, env);
		const result = await fetch(`${env.SIGNET_DAEMON_URL}/api/inference/execute`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: nonce, explicitTargets: ["installed/default"] }),
			signal: AbortSignal.timeout(30_000),
		});
		const body = await result.text();
		if (!result.ok || !body.includes(nonce) || calls !== 1)
			throw new Error(`Installed inference did not reach the provider stub: ${result.status} ${body}, calls=${calls}`);
		report = JSON.stringify({
			installedResources: resources,
			diagnostics: runtime.trim(),
			inference: "real-daemon-provider-round-trip",
			providerRequests: calls,
		});
	} finally {
		try {
			await running.stop();
			rmSync(root, { recursive: true, force: true });
		} finally {
			stub.closeAllConnections();
			await new Promise<void>((accept, reject) => stub.close((error) => (error ? reject(error) : accept())));
		}
	}
	console.log(report);
}

if (import.meta.main) await main();

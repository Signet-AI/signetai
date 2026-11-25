import "../tests/support/connector-safety.js";
import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHermeticEnvironment } from "../scripts/run-hermetic-tests";

const env = { ...process.env };
let root = "";

afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in env)) Reflect.deleteProperty(process.env, key);
	Object.assign(process.env, env);
	if (root) rmSync(root, { recursive: true, force: true });
});

function contents(path: string): string {
	if (!existsSync(path)) return "";
	if (!statSync(path).isDirectory()) return readFileSync(path, "utf-8");
	return readdirSync(path)
		.map((name) => contents(join(path, name)))
		.join("\n");
}

const connectors = [
	{ name: "kimi", entry: "KimiConnector" },
	{ name: "pi", entry: "PiConnector" },
	{ name: "oh-my-pi", entry: "OhMyPiConnector" },
	{ name: "muse-code", entry: "MuseCodeConnector" },
	{ name: "forge", entry: "ForgeConnector" },
	{ name: "opencode", entry: "OpenCodeConnector" },
	{ name: "hermes-agent", entry: "HermesAgentConnector" },
];

test.each(
	connectors
		.filter((connector) => connector.name !== "muse-code" || process.platform !== "win32")
		.flatMap((connector) => [
			{ ...connector, remote: false },
			{ ...connector, remote: true },
		]),
)("$name installs use daemon auth policy; remote=$remote", async ({ name, entry, remote }) => {
	root = mkdtempSync(join(tmpdir(), "sync-policy-"));
	Object.assign(process.env, buildHermeticEnvironment(env, root));
	process.env.SIGNET_CLI_PATH = "/host/bin/signet";
	process.env.SIGNET_API_KEY = "sig_sk_sync_policy_fixture";
	process.env.SIGNET_AGENT_ID = "default";
	process.env.SIGNET_SKIP_AGENT_REGISTER = "1";
	process.env.HERMES_HOME = join(root, "hermes");
	process.env.HERMES_REPO = join(root, "missing-repo");
	process.env.PI_CODING_AGENT_DIR = join(root, "pi");
	process.env.KIMI_SHARE_DIR = join(root, "kimi");
	const workspace = join(root, "agents");
	mkdirSync(workspace);
	for (const file of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"])
		writeFileSync(join(workspace, file), "fixture");
	process.env.SIGNET_PATH = workspace;
	let requiresAuth: boolean | null = true;
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			if (new URL(req.url).pathname === "/api/mode") {
				return requiresAuth === null ? new Response("offline", { status: 503 }) : Response.json({ requiresAuth });
			}
			return Response.json({ agents: [] });
		},
	});
	process.env.SIGNET_PORT = String(server.port);
	if (remote) process.env.SIGNET_DAEMON_URL = server.url.origin;
	if (!remote) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
	try {
		for (const mode of [true, false, null]) {
			requiresAuth = mode;
			if (mode === false) Reflect.deleteProperty(process.env, "SIGNET_CLI_PATH");
			if (mode === null) process.env.SIGNET_HOOK_COMMAND = "/override/signet";
			const source = join(import.meta.dir, name, "connector/src/index.ts");
			const child = Bun.spawn(
				[
					process.execPath,
					"--eval",
					`const { ${entry} } = await import(${JSON.stringify(source)}); console.log(JSON.stringify(await new ${entry}().install(${JSON.stringify(workspace)})));`,
				],
				{ env: process.env, stdout: "pipe", stderr: "pipe" },
			);
			const timer = setTimeout(() => child.kill(), 10_000);
			const [stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]).finally(() => clearTimeout(timer));
			expect({ exit, stderr }).toMatchObject({ exit: 0 });
			expect(stdout).toContain('"success":true');
			const written = contents(root);
			expect(written.includes("sig_sk_sync_policy_fixture")).toBe(mode === true);
			if (["kimi", "muse-code", "forge", "opencode"].includes(name) && !remote) {
				const command = mode === null ? "/override/signet" : "/host/bin/signet";
				expect(written).toContain(command);
				if (name === "kimi")
					expect(readFileSync(join(root, "kimi/config.toml"), "utf-8")).toContain(`${command} hook session-start`);
				if (name === "muse-code")
					expect(readFileSync(join(root, "xdg-config", "muse/settings.json"), "utf-8")).toContain(
						`${command} hook session-start`,
					);
			}
			if (mode === null) expect(stdout).toContain("SIGNET_API_KEY was omitted");
			if (!remote && name === "kimi") {
				const path = join(root, "kimi/mcp.json");
				expect(readFileSync(path, "utf-8")).toContain(mode === null ? "/override/signet" : "/host/bin/signet");
				if (mode === true) rmSync(path);
			}
			if (!remote && name === "muse-code") {
				const path = join(root, "xdg-config/muse/settings.json");
				const config = JSON.parse(readFileSync(path, "utf-8"));
				expect(config.mcp_servers.signet.command).toBe(mode === null ? "/override/signet" : "/host/bin/signet");
				if (mode === true) {
					Reflect.deleteProperty(config, "mcp_servers");
					writeFileSync(path, JSON.stringify(config));
				}
			}
		}
	} finally {
		server.stop(true);
	}
});

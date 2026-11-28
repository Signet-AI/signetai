import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSocketPath } from "../../../platform/core/src/local-endpoint";
import { socketFetch } from "../../../surfaces/cli/src/lib/socket-transport";
import { OrgDaemon, repo } from "./daemon";
import { Fixture } from "./fixture";
import { record, request, success, type Credential, type Reply } from "./http";

export const fixtureAnswer = "The host fixture answered.";
export class HostFixture {
	private constructor(
		readonly daemon: OrgDaemon,
		readonly identity: Fixture,
		readonly runtime: string,
		readonly external: Bun.Server<undefined>,
		readonly upstream: string,
		readonly peer: string,
		readonly externalCalls: string[],
	) {}
	get socket(): string {
		return workspaceSocketPath(this.daemon.workspace, this.daemon.env);
	}
	async raw(path: string, method = "GET", body?: object): Promise<Response> {
		return socketFetch(this.socket, `${this.daemon.origin}${path}`, {
			method,
			headers: { "content-type": "application/json", "x-signet-agent-id": "default" },
			body: body ? JSON.stringify(body) : undefined,
		});
	}
	async local(path: string, method = "GET", body?: object): Promise<Reply> {
		const response = await this.raw(path, method, body);
		const raw = await response.text();
		return {
			status: response.status,
			headers: response.headers,
			body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(raw) : raw,
		};
	}
	async tcp(path: string, credential: Credential, method = "GET", body?: object): Promise<Reply> {
		return request(this.daemon.origin, path, credential, method, body);
	}
	async command(args: string[], cwd = this.daemon.root): Promise<string> {
		return run(args, this.daemon.env, cwd);
	}
	async dispose(): Promise<void> {
		try {
			await this.daemon.dispose();
		} finally {
			await this.external.stop(true);
			await rm(this.runtime, { recursive: true, force: true });
		}
	}
	static async create(): Promise<HostFixture> {
		const runtime = await mkdtemp(join(tmpdir(), ""));
		const calls: string[] = [];
		let archive = new Uint8Array();
		let digest = "";
		const external = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				calls.push(`${req.method} ${url.pathname}`);
				if (url.pathname.includes("/releases/download/")) return new Response(archive);
				if (url.pathname.includes("/releases/tags/"))
					return Response.json({
						assets: [{ name: "graphiq-x86_64-unknown-linux-gnu.tar.gz", digest: `sha256:${digest}` }],
					});
				if (url.pathname === "/v1/models")
					return Response.json({
						object: "list",
						data: [{ id: "host-fixture", object: "model", owned_by: "fixture" }],
					});
				if (url.pathname === "/v1/chat/completions") {
					const body = record(await req.json());
					const held = JSON.stringify(body).includes("host-gap-hold");
					if (!body.stream)
						return Response.json({
							id: "chatcmpl-fixture",
							object: "chat.completion",
							created: 1,
							model: "host-fixture",
							choices: [{ index: 0, message: { role: "assistant", content: fixtureAnswer }, finish_reason: "stop" }],
							usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
						});
					const delta = `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "host-fixture", choices: [{ index: 0, delta: { role: "assistant", content: fixtureAnswer }, finish_reason: null }] })}\n\n`;
					const done = `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "host-fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`;
					if (!held) return new Response(delta + done, { headers: { "content-type": "text/event-stream" } });
					let timer: ReturnType<typeof setInterval> | undefined;
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(delta));
								timer = setInterval(() => controller.enqueue(new TextEncoder().encode(": alive\n\n")), 100);
							},
							cancel() {
								clearInterval(timer);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				if (url.pathname.endsWith("/issues"))
					return Response.json(
						url.searchParams.get("page") === "2"
							? []
							: [
									{
										id: 101,
										number: 1,
										title: "Host fixture issue",
										body: "Host fixture evidence.",
										state: "open",
										html_url: "https://github.com/fixture/repo/issues/1",
										created_at: "2026-01-01T00:00:00Z",
										updated_at: "2026-01-01T00:00:00Z",
										labels: [],
										user: { login: "fixture" },
										comments: 0,
									},
								],
					);
				if (url.pathname.endsWith("/channels"))
					return Response.json([
						{ id: "456789012345678901", guild_id: "123456789012345678", type: 0, name: "fixture" },
					]);
				if (url.pathname.endsWith("/messages"))
					return Response.json(
						url.searchParams.has("before")
							? []
							: [
									{
										id: "1750000000000000000",
										channel_id: "456789012345678901",
										content: "Host fixture Discord evidence.",
										timestamp: "2026-01-01T00:00:00Z",
										author: { id: "789012345678901234", username: "fixture", bot: false },
										attachments: [],
										embeds: [],
									},
								],
					);
				if (url.pathname.includes("threads")) return Response.json({ threads: [], members: [], has_more: false });
				if (url.pathname.includes("/guilds/")) return Response.json({ id: "123456789012345678", name: "Fixture" });
				if (url.pathname === "/repos/fixture/repo")
					return Response.json({ id: 1, full_name: "fixture/repo", default_branch: "main" });
				return Response.json({ error: `Unknown fixture external request: ${url.pathname}` }, { status: 404 });
			},
		});
		let daemon: OrgDaemon | undefined;
		try {
			daemon = await OrgDaemon.create(async (host) => {
				host.preload = join(import.meta.dir, "host-provider-fakes.ts");
				host.env.XDG_RUNTIME_DIR = runtime;
				await writeFile(join(host.root, "host-fixture.json"), JSON.stringify({ origin: external.url.origin }));
				host.env.GIT_CONFIG_NOSYSTEM = "1";
				const bin = join(host.root, "bin");
				const packageDir = join(host.root, "release");
				await mkdir(bin);
				await mkdir(packageDir);
				await mkdir(join(host.home, ".local/bin"), { recursive: true });
				await writeFile(join(host.home, ".local/bin/graphiq"), "#!/bin/sh\nprintf 'host-fixture-before-update\\n'\n", {
					mode: 0o755,
				});
				const binary = join(packageDir, "graphiq");
				await writeFile(binary, "#!/bin/sh\nprintf 'host-fixture-graphiq\\n'\n");
				await chmod(binary, 0o755);
				await run(["tar", "czf", join(host.root, "release.tar.gz"), "graphiq"], host.env, packageDir);
				archive = new Uint8Array(await readFile(join(host.root, "release.tar.gz")));
				digest = createHash("sha256").update(archive).digest("hex");
				const curl = Bun.which("curl");
				assert(curl);
				await writeFile(
					join(bin, "curl"),
					`#!${process.execPath}\nconst origin = ${JSON.stringify(external.url.origin)};\nconst args = process.argv.slice(2).map(arg => arg.startsWith("https://github.com/aaf2tbz/graphiq/") || arg.startsWith("https://api.github.com/repos/aaf2tbz/graphiq/") ? origin + new URL(arg).pathname : arg);\nconst child = Bun.spawn([${JSON.stringify(curl)}, ...args], {stdin:"inherit",stdout:"inherit",stderr:"inherit"});\nprocess.exit(await child.exited);\n`,
				);
				await chmod(join(bin, "curl"), 0o755);
				await writeFile(join(bin, "ldconfig"), "#!/bin/sh\nprintf 'libvulkan.so.1\\n'\n");
				await chmod(join(bin, "ldconfig"), 0o755);
				for (const name of ["claude", "codex", "ollama", "opencode", "acpx"]) {
					await writeFile(join(bin, name), "#!/bin/sh\nprintf 'host-fixture-1.0\\n'\n");
					await chmod(join(bin, name), 0o755);
				}
				host.env.PATH = `${bin}:${host.env.PATH}`;
				host.env.GIT_SSH_COMMAND = join(bin, "ssh");
				host.env.GIT_SSH_VARIANT = "ssh";
				await writeFile(
					join(bin, "ssh"),
					'#!/bin/sh\ncase "$*" in\n  *host-fixture*git-upload-pack*) exec git upload-pack "${TMPDIR}/upstream.git" ;;\n  *host-fixture*git-receive-pack*) exec git receive-pack "${TMPDIR}/upstream.git" ;;\n  *) exit 64 ;;\nesac\n',
				);
				await chmod(join(bin, "ssh"), 0o755);
				await writeFile(join(host.root, "bitwarden.json"), "[]", { mode: 0o600 });
				await writeFile(
					join(host.home, ".gitconfig"),
					"[user]\n  name = Host Fixture\n  email = fixture@example.test\n[init]\n  defaultBranch = main\n",
				);
				await mkdir(join(host.workspace, "scripts"));
				await copyFile(
					join(repo, "surfaces/cli/templates/scripts/generate-harness-configs.py"),
					join(host.workspace, "scripts/generate-harness-configs.py"),
				);
				await mkdir(join(host.workspace, "skills/host-fixture"), { recursive: true });
				await writeFile(
					join(host.workspace, "skills/host-fixture/SKILL.md"),
					"---\nname: host-fixture\ndescription: Fixture skill\n---\nFixture instructions.\n",
				);
				const config = join(host.workspace, "agent.yaml");
				await writeFile(
					config,
					`${await readFile(config, "utf8")}\ninference:\n  defaultPolicy: host-fixture\n  accounts:\n    fixture:\n      kind: api\n      providerFamily: groq\n      credentialRef: HOST_MODEL\n  targets:\n    local:\n      executor: openai-compatible\n      account: fixture\n      endpoint: ${external.url.origin}/v1\n      models:\n        default:\n          model: llama-3.3-70b-versatile\n          streaming: true\n  policies:\n    host-fixture:\n      mode: strict\n      defaultTargets: [local/default]\n  workloads:\n    interactive:\n      policy: host-fixture\n`,
				);
				const peer = join(host.root, "peer");
				const upstream = join(host.root, "upstream.git");
				await run(["git", "init", "--bare", upstream], host.env, host.root);
				await run(["git", "clone", upstream, peer], host.env, host.root);
				await writeFile(
					join(peer, ".gitignore"),
					"# BEGIN Signet lightweight workspace\n*\n!.gitignore\n!host-fixture.txt\n",
				);
				await writeFile(join(peer, "host-fixture.txt"), "initial\n");
				await run(["git", "add", ".gitignore", "host-fixture.txt"], host.env, peer);
				await run(["git", "commit", "-m", "fixture seed"], host.env, peer);
				await run(["git", "push", "-u", "origin", "main"], host.env, peer);
				await run(["git", "init", "--initial-branch=host-fixture"], host.env, host.workspace);
				await run(["git", "remote", "add", "origin", `git@host-fixture:${upstream}`], host.env, host.workspace);
				await run(["git", "fetch", "origin"], host.env, host.workspace);
				await run(["git", "checkout", "-b", "main", "origin/main"], host.env, host.workspace);
			});
			const identity = await Fixture.createIdentity(daemon);
			const fixture = new HostFixture(
				daemon,
				identity,
				runtime,
				external,
				join(daemon.root, "upstream.git"),
				join(daemon.root, "peer"),
				calls,
			);
			const policy = success(await fixture.local("/api/org/remote-features"), "local feature policy");
			assert(Array.isArray(policy.features) && policy.features.every((entry) => record(entry).allowed === false));
			for (const name of ["HOST_GITHUB", "HOST_DISCORD", "HOST_MODEL"])
				success(
					await fixture.local(`/api/secrets/${name}`, "POST", { value: randomBytes(24).toString("base64url") }),
					"fixture credential",
				);
			return fixture;
		} catch (error) {
			await daemon?.dispose();
			await external.stop(true);
			await rm(runtime, { recursive: true, force: true });
			throw error;
		}
	}
}
async function run(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
	const child = Bun.spawn(args, { env, cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	assert.equal(code, 0, `${args[0]} fixture command: ${stderr}`);
	return stdout;
}
export function rows(value: unknown): Record<string, unknown>[] {
	assert(Array.isArray(value));
	return value.map(record);
}
export function eventRows(value: string): Record<string, unknown>[] {
	return value
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => record(JSON.parse(line.slice(5))));
}

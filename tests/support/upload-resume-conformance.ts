import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OrgDaemon, repo } from "../integration/org-mode/daemon";
import { Fixture } from "../integration/org-mode/fixture";
import { record, request, text, until } from "../integration/org-mode/http";
import conformance from "../fixtures/connector-conformance.json";
export async function runUploadResume(runtime: string, name: string): Promise<void> {
	const scenario = conformance.uploads.find((entry) => entry.name === name);
	assert(scenario);
	const daemon = await OrgDaemon.create();
	let server: ReturnType<typeof Bun.serve> | undefined;
	let first: ReturnType<typeof Bun.spawn> | undefined;
	let release: (() => void) | undefined;
	try {
		const fixture = await Fixture.createIdentity(daemon),
			user = fixture.user("alice");
		const data = Buffer.alloc(scenario.totalBytes, "User: preserve restart evidence.\nAssistant: acknowledged.\n");
		const source = join(daemon.home, "resume-transcript.txt"),
			config = join(daemon.home, "resume-client.json");
		await writeFile(source, data, { mode: 0o600 });
		let paused = true,
			patches = 0,
			interrupted = false;
		const resumedOffsets: number[] = [];
		const calls: string[] = [];
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const url = new URL(req.url),
					body = await req.arrayBuffer();
				calls.push(
					req.method +
						" " +
						url.pathname +
						" " +
						(req.headers.get("content-type") === "application/json"
							? Object.keys(record(JSON.parse(new TextDecoder().decode(body)))).join(",")
							: String(body.byteLength)),
				);
				if (!paused && req.method === "PATCH") resumedOffsets.push(Number(req.headers.get("upload-offset")));
				const reply = await fetch(daemon.origin + url.pathname, {
					method: req.method,
					headers: req.headers,
					body: body.byteLength ? body : undefined,
					redirect: "error",
				});
				const bytes = await reply.arrayBuffer();
				if (paused && req.method === "PATCH" && ++patches === scenario.interruptAfterChunks) {
					assert.equal(reply.status, 200);
					interrupted = true;
					await new Promise<void>((done) => {
						release = done;
					});
				}
				return new Response(bytes, { status: reply.status, headers: reply.headers });
			},
		});
		const origin = `http://127.0.0.1:${server.port}`;
		assert(user.connector.bearer);
		await writeFile(
			config,
			JSON.stringify({ url: origin, key: user.connector.bearer, source, agentId: user.agentId }),
			{ mode: 0o600 },
		);
		const client =
			runtime === "python"
				? ["python3", join(repo, "tests/support/upload_resume_client.py")]
				: [process.execPath, join(repo, "tests/support/upload-resume-client.ts")];
		first = Bun.spawn([...client, config, "initial"], { env: daemon.env, stdout: "pipe", stderr: "pipe" });
		await until(
			async () => {
				if (first && first.exitCode !== null) {
					if (typeof first.stderr === "number" || first.stderr === undefined)
						throw new Error("Client stderr is unavailable");
					const diagnostic = (await new Response(first.stderr).text()).replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]");
					throw new Error(
						"Client exited before upload interruption: " +
							diagnostic +
							"\n" +
							calls.join("\n") +
							"\n" +
							daemon.stdout
								.split("\n")
								.filter((line) => /ERROR|DbOwnerError|Error:/.test(line))
								.join("\n"),
					);
				}
				return interrupted;
			},
			"durable interrupted upload",
			15_000,
		);
		first.kill("SIGKILL");
		await first.exited;
		const partition = join(
			daemon.home,
			".config/signet/outbox",
			createHash("sha256").update(origin).digest("hex"),
			"codex",
		);
		const claims = await readdir(join(partition, ".claims"));
		const entryPath = claims.find((name) => name.endsWith(".json"));
		assert(entryPath);
		const entry = record(JSON.parse(await readFile(join(partition, ".claims", entryPath), "utf8")));
		const upload = record(entry.upload);
		const savedOffset = upload.receivedBytes;
		assert.equal(savedOffset, 1024 * 1024);
		const progress = await request(
			daemon.origin,
			`/api/hooks/session-end/uploads/${text(upload.uploadId)}`,
			user.connector,
		);
		assert.equal(record(progress.body).receivedBytes, 2 * 1024 * 1024);
		paused = false;
		release?.();
		const trace = join(daemon.home, "resume-io.log");
		const tracing = process.platform === "linux" && Bun.which("strace") !== null;
		const traceArgs = tracing
			? ["strace", "-f", "-yy", "-s", "0", "-e", "trace=read,pread64,preadv,preadv2,lseek", "-o", trace]
			: [];
		const resumed = Bun.spawn([...traceArgs, ...client, config, "resume"], {
			env: daemon.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, , err] = await Promise.all([
			resumed.exited,
			new Response(resumed.stdout).text(),
			new Response(resumed.stderr).text(),
		]);
		assert.equal(code, 0, err.replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]"));
		assert.equal(resumedOffsets[0], 2 * 1024 * 1024, "Resume must use the server offset, not the stale checkpoint");
		console.log(
			`${runtime}: persisted offset=${savedOffset}, resumed server offset=${resumedOffsets[0]}, file-I/O trace=${tracing}`,
		);
		if (tracing) {
			const reads = (await readFile(trace, "utf8"))
				.split("\n")
				.filter((line) => line.includes(`<${source}>`) && /pread64\(/.test(line));
			assert(reads.length > 0, "Trace must observe actual transcript reads");
			for (const line of reads) {
				const match = /, (\d+)\)\s*=/.exec(line);
				assert(match, `Unrecognized file read: ${line}`);
				assert(Number(match[1]) >= 2 * 1024 * 1024, "Resume reread bytes before server offset");
			}
		}
		await until(
			async () => {
				const reply = await request(
					daemon.origin,
					`/api/sessions/a21-resume-conformance/transcript?agent_id=${encodeURIComponent(user.agentId)}`,
					user.session,
				);
				return reply.status === 200 && Buffer.from(text(record(reply.body).content)).equals(data);
			},
			"byte-exact resumed evidence",
			60_000,
		);
	} finally {
		release?.();
		if (first && first.exitCode === null) {
			first.kill("SIGKILL");
			await first.exited;
		}
		server?.stop(true);
		await daemon.dispose();
	}
}
if (import.meta.main) {
	const runtime = process.argv[2],
		name = process.argv[3];
	assert(runtime && name);
	await runUploadResume(runtime, name);
}

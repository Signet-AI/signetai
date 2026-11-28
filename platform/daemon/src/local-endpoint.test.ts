import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindLocalEndpoint, localTransportIdentity } from "./local-endpoint";

function get(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = request({ socketPath: path, path: "/", headers: { "x-signet-principal": "user" } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				text += chunk;
			});
			res.on("end", () => resolve(text));
		});
		req.on("error", reject);
		req.end();
	});
}

test("local endpoint confines authority to a private socket and restarts cleanly", async () => {
	const root = await mkdtemp(join(tmpdir(), "local-endpoint-"));
	const path = join(root, "private", "daemon.sock");
	const fetch = () => Response.json(localTransportIdentity());
	try {
		const endpoint = await bindLocalEndpoint(path, fetch);
		try {
			expect((await lstat(join(root, "private"))).mode & 0o777).toBe(0o700);
			expect((await lstat(path)).mode & 0o777).toBe(0o600);
			expect((await lstat(path)).uid).toBe(process.getuid?.());
			expect(JSON.parse(await get(path)).uid).toBe(process.getuid?.());
			expect(localTransportIdentity()).toBeUndefined();
			await expect(bindLocalEndpoint(path, fetch)).rejects.toThrow("listening");
		} finally {
			await endpoint.close();
		}
		await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
		const restarted = await bindLocalEndpoint(path, fetch);
		await restarted.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("local endpoint recovers only a dead owned socket", async () => {
	const root = await mkdtemp(join(tmpdir(), "local-stale-"));
	const path = join(root, "private", "daemon.sock");
	await mkdir(join(root, "private"), { mode: 0o700 });
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const s=require('node:net').createServer();s.listen(${JSON.stringify(path)},()=>console.log('ready'));`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	try {
		const reader = child.stdout.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
		reader.releaseLock();
		child.kill("SIGKILL");
		await child.exited;
		expect((await lstat(path)).isSocket()).toBe(true);
		const recovered = await bindLocalEndpoint(path, () => new Response("recovered"));
		try {
			expect(await get(path)).toBe("recovered");
		} finally {
			await recovered.close();
		}
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test("local endpoint refuses symlinked and permissive directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "local-refuse-"));
	try {
		await mkdir(join(root, "target"), { mode: 0o700 });
		await symlink(join(root, "target"), join(root, "link"));
		await expect(bindLocalEndpoint(join(root, "link", "daemon.sock"), () => new Response())).rejects.toThrow(
			"directory",
		);
		await mkdir(join(root, "open"), { mode: 0o755 });
		await expect(bindLocalEndpoint(join(root, "open", "daemon.sock"), () => new Response())).rejects.toThrow(
			"directory",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

async function nodeBinary(): Promise<string> {
	const bun = await realpath(process.execPath);
	for (const path of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = Bun.which("node", { PATH: path });
		if (candidate && (await realpath(candidate)) !== bun) return candidate;
	}
	throw new Error("A real Node runtime is required for the SDK package contract test");
}

test("core bundles for browsers within 64 KiB", async () => {
	const build = await Bun.build({ entrypoints: [new URL("../index.ts", import.meta.url).pathname], target: "browser" });
	expect(build.success).toBe(true);
	expect(build.outputs.reduce((n, output) => n + output.size, 0)).toBeLessThan(64 * 1024);
});

test("compiled core and node entrypoints work in Node with shared error identity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "sdk-package-"));
	const server = Bun.serve({
		port: 0,
		fetch: (req) =>
			Response.json({ error: "expired", reason: "expired", actor: req.headers.get("x-signet-actor") }, { status: 401 }),
	});
	try {
		const root = new URL("../../../../", import.meta.url).pathname;
		await symlink(join(root, "libs/sdk/node_modules"), join(directory, "node_modules"), "dir");
		const build = await Bun.build({
			entrypoints: [new URL("../index.ts", import.meta.url).pathname, new URL("../node.ts", import.meta.url).pathname],
			target: "node",
			splitting: true,
			outdir: directory,
			external: ["@signet/core/*"],
		});
		expect(build.success).toBe(true);
		const browser = await Bun.build({ entrypoints: [join(directory, "index.js")], target: "browser" });
		expect(browser.success).toBe(true);
		expect(browser.outputs.reduce((n, output) => n + output.size, 0)).toBeLessThan(64 * 1024);
		const script = `import { SignetClient, SignetUnauthorizedError } from ${JSON.stringify(pathToFileURL(join(directory, "index.js")).href)};
import { NodeTransport, resolveTarget } from ${JSON.stringify(pathToFileURL(join(directory, "node.js")).href)};
if (process.versions.bun) throw new Error("Expected Node, not Bun");
const target = await resolveTarget({flagUrl:${JSON.stringify(`http://127.0.0.1:${server.port}`)},flagKey:'fixture'});
const client = new SignetClient({transport:new NodeTransport(target)});
try { await client.whoami(); process.exitCode=2; } catch (error) { if (!(error instanceof SignetUnauthorizedError) || error.reason!=='expired') throw error; console.log('node-auth-typed'); }`;
		const child = Bun.spawn([await nodeBinary(), "--input-type=module", "--eval", script], {
			env: { ...process.env, HOME: directory, APPDATA: join(directory, "AppData", "Roaming") },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, stderr).toBe(0);
		expect(stdout).toContain("node-auth-typed");
	} finally {
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
});

test("guarded Bun package scripts produce fresh build artifacts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "sdk-guarded-build-"));
	try {
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({ scripts: { build: "bun build probe.ts --outdir dist" } }),
		);
		await writeFile(join(directory, "probe.ts"), "export const built = true;");
		const child = Bun.spawn([process.execPath, "run", "build"], {
			cwd: directory,
			env: { ...process.env, HOME: directory },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, stderr).toBe(0);
		expect(await Bun.file(join(directory, "dist/probe.js")).exists(), stdout + stderr).toBe(true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

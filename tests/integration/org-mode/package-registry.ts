import { isJsonObject } from "@signet/connector-base";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { buildHermeticEnvironment } from "../../../scripts/run-hermetic-tests";
import { repo } from "./daemon";

export async function packageRegistry(root: string) {
	const directory = join(root, "package-registry");
	await mkdir(directory, { recursive: true });
	const plugin = join(repo, "integrations/openclaw/memory-adapter");
	const require = createRequire(join(plugin, "package.json"));
	const typebox = dirname(require.resolve("@sinclair/typebox/package.json"));
	const packages = new Map<
		string,
		{ manifest: Record<string, unknown>; tarball: string; filename: string; integrity: string }
	>();
	for (const source of [plugin, typebox]) {
		const manifest: unknown = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
		if (!isJsonObject(manifest) || typeof manifest.name !== "string" || typeof manifest.version !== "string")
			throw new Error("Package fixture requires a named, versioned manifest");
		const before = new Set(await readdir(directory));
		const child = Bun.spawn(["npm", "pack", source, "--ignore-scripts", "--pack-destination", directory], {
			env: buildHermeticEnvironment({ PATH: process.env.PATH }, join(directory, "pack-home")),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if ((await child.exited) !== 0) throw new Error(`Packing fixture package failed: ${err}`);
		const created = (await readdir(directory)).filter((name) => name.endsWith(".tgz") && !before.has(name));
		const filename = created[0];
		if (created.length !== 1 || typeof filename !== "string")
			throw new Error("Package manager did not create one tarball");
		if (basename(filename) !== filename) throw new Error("Package tarball escaped fixture directory");
		const tarball = join(directory, filename);
		const integrity = `sha512-${createHash("sha512")
			.update(await readFile(tarball))
			.digest("base64")}`;
		packages.set(manifest.name, { manifest, tarball, filename, integrity });
	}
	const requested = new Set<string>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			const path = decodeURIComponent(url.pathname.slice(1));
			requested.add(path);
			for (const entry of packages.values()) {
				if (path === `tarballs/${entry.filename}`) return new Response(Bun.file(entry.tarball));
			}
			const entry = packages.get(path);
			if (!entry) return Response.json({ error: "Fixture package not found" }, { status: 404 });
			requested.add(path);
			const version = entry.manifest.version;
			if (typeof version !== "string") throw new Error("Fixture package lost its version");
			return Response.json({
				name: path,
				"dist-tags": { latest: version },
				versions: {
					[version]: {
						...entry.manifest,
						dist: { tarball: `${url.origin}/tarballs/${entry.filename}`, integrity: entry.integrity },
					},
				},
			});
		},
	});
	return { origin: server.url.origin, requested, stop: () => server.stop(true) };
}

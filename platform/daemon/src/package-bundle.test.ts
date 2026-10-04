import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const prepared = new Set<string>();

function prepareDashboard(dir: string): void {
	if (prepared.has(dir)) return;

	const prep = spawnSync("bun", ["run", "build:dashboard"], {
		cwd: dir,
		encoding: "utf8",
		env: {
			...process.env,
			TERM: process.env.TERM || "xterm",
		},
	});

	if (prep.status !== 0) {
		throw new Error(prep.stderr || prep.stdout || `dashboard prep failed in ${dir}`);
	}

	prepared.add(dir);
}

function packFiles(dir: string, prepare = true): string[] {
	if (prepare) prepareDashboard(dir);

	const res = spawnSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: dir,
		encoding: "utf8",
		env: {
			...process.env,
			TERM: process.env.TERM || "xterm",
		},
	});

	if (res.status !== 0) {
		throw new Error(res.stderr || res.stdout || `npm pack failed in ${dir}`);
	}

	const parsed = JSON.parse(res.stdout);
	if (!Array.isArray(parsed)) {
		throw new Error(`unexpected npm pack payload for ${dir}`);
	}

	const first = parsed[0];
	if (typeof first !== "object" || first === null) {
		throw new Error(`missing npm pack entry for ${dir}`);
	}

	const files = Reflect.get(first, "files");
	if (!Array.isArray(files)) {
		throw new Error(`missing npm pack files list for ${dir}`);
	}

	return files.flatMap((file) => {
		if (typeof file !== "object" || file === null) return [];
		const path = Reflect.get(file, "path");
		return typeof path === "string" ? [path] : [];
	});
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, "..", "..", "..");

describe("published package dashboard bundles", () => {
	test("platform/daemon pack output includes dashboard assets", () => {
		const files = packFiles(resolve(root, "platform", "daemon"));
		expect(files).toContain("dashboard/index.html");
	}, 60_000);

	test("dist/signetai pack output includes the staged daemon runtime dashboard", () => {
		const files = packFiles(resolve(root, "dist", "signetai"), false);
		expect(files).toContain("runtime/daemon-js/dashboard/index.html");
	}, 60_000);
});

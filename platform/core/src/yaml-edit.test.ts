import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editYamlConfigFile } from "./yaml";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-yaml-edit-"));
	dirs.push(dir);
	const path = join(dir, "agent.yaml");
	writeFileSync(path, text);
	return path;
}

describe("editYamlConfigFile", () => {
	it("edits nested keys while keeping comments, other keys and a backup", () => {
		const original = "# my agent\nname: ant # keep me\nmemory:\n  pipelineV2:\n    reranker:\n      topN: 20\n";
		const path = file(original);
		editYamlConfigFile(path, (config) => {
			expect(config.get(["memory", "pipelineV2", "reranker", "topN"])).toBe(20);
			config.set(["memory", "pipelineV2", "reranker", "device"], "cpu");
			config.set(["embedding", "runtime"], "onnxruntime");
		});
		const next = readFileSync(path, "utf8");
		expect(next).toContain("# my agent");
		expect(next).toContain("name: ant # keep me");
		expect(next).toContain("device: cpu");
		expect(next).toContain("runtime: onnxruntime");
		expect(readFileSync(`${path}.bak`, "utf8")).toBe(original);
	});

	it("rejects a concurrent process editing the same target through another symlink", () => {
		const path = file("name: ant\n");
		const alias = `${path}.link`;
		symlinkSync(path, alias);
		editYamlConfigFile(path, (config) => {
			const child = Bun.spawnSync([
				process.execPath,
				"-e",
				`import { editYamlConfigFile } from ${JSON.stringify(join(import.meta.dir, "yaml.ts"))};
				try { editYamlConfigFile(${JSON.stringify(alias)}, editor => editor.set(["other"], true)); }
				catch (error) { console.error(error.message); process.exit(2); }`,
			]);
			expect(child.exitCode).toBe(2);
			expect(child.stderr.toString()).toContain("being edited");
			config.set(["name"], "edited");
		});
		expect(readFileSync(path, "utf8")).toBe("name: edited\n");
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	it("writes through a config symlink without replacing it", () => {
		const path = file("name: ant\n");
		const alias = `${path}.link`;
		symlinkSync(path, alias);
		editYamlConfigFile(alias, (config) => config.set(["name"], "edited"));
		expect(lstatSync(alias).isSymbolicLink()).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("name: edited\n");
		expect(readFileSync(`${path}.bak`, "utf8")).toBe("name: ant\n");
	});

	it("preserves config and backup permissions despite a permissive umask", () => {
		const path = file("name: ant\n");
		chmodSync(path, 0o640);
		const previous = process.umask(0o022);
		try {
			editYamlConfigFile(path, (config) => config.set(["name"], "edited"));
		} finally {
			process.umask(previous);
		}
		expect(statSync(path).mode & 0o777).toBe(0o640);
		expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o640);
	});

	it("releases the config lock when an editor throws", () => {
		const path = file("name: ant\n");
		expect(() =>
			editYamlConfigFile(path, () => {
				throw new Error("editor failed");
			}),
		).toThrow("editor failed");
		editYamlConfigFile(path, (config) => config.set(["name"], "edited"));
		expect(readFileSync(path, "utf8")).toBe("name: edited\n");
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	it("does not overwrite an edit from a writer that does not use the lock", () => {
		const path = file("name: ant\n");
		expect(() =>
			editYamlConfigFile(path, (config) => {
				writeFileSync(path, "name: external\n");
				config.set(["name"], "edited");
			}),
		).toThrow("changed while being edited");
		expect(readFileSync(path, "utf8")).toBe("name: external\n");
		expect(existsSync(`${path}.bak`)).toBe(false);
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	it("replaces a backup symlink without writing to its target", () => {
		const path = file("name: ant\n");
		const other = file("unrelated\n");
		symlinkSync(other, `${path}.bak`);
		editYamlConfigFile(path, (config) => config.set(["name"], "edited"));
		expect(readFileSync(other, "utf8")).toBe("unrelated\n");
		expect(readFileSync(`${path}.bak`, "utf8")).toBe("name: ant\n");
	});

	it("does not report a committed config edit as failed when its lock was removed", () => {
		const path = file("name: ant\n");
		expect(() =>
			editYamlConfigFile(path, (config) => {
				rmSync(`${path}.lock`);
				config.set(["name"], "edited");
			}),
		).not.toThrow();
		expect(readFileSync(path, "utf8")).toBe("name: edited\n");
	});

	it("refuses a file it cannot parse and leaves it untouched", () => {
		const broken = "name: ant\nmemory:\n  pipelineV2: [unclosed\n";
		const path = file(broken);
		expect(() => editYamlConfigFile(path, (config) => config.set(["embedding", "runtime"], "onnxruntime"))).toThrow(
			/not valid YAML/,
		);
		expect(readFileSync(path, "utf8")).toBe(broken);
		expect(existsSync(`${path}.bak`)).toBe(false);
	});

	it("refuses a document whose top level is not a mapping", () => {
		const path = file("- one\n- two\n");
		expect(() => editYamlConfigFile(path, () => {})).toThrow(/mapping/);
	});
});

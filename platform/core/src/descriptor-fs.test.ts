import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDescriptorRoot, UnsupportedDescriptorFilesystemError } from "./descriptor-fs";

const roots: string[] = [];

function temporaryRoot(name: string): string {
	const root = mkdtempSync(join(tmpdir(), `${name}-`));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("descriptor-rooted filesystem", () => {
	test("refuses a file or directory mode the destination filesystem cannot preserve", async () => {
		const rootPath = temporaryRoot("descriptor-mode");
		const probe = join(rootPath, "permission-probe");
		writeFileSync(probe, "probe", { mode: 0o600 });
		chmodSync(probe, 0o600);
		const preservesMode = (lstatSync(probe).mode & 0o777) === 0o600;
		const root = await openDescriptorRoot(rootPath);
		try {
			const write = root.writeFileAtomic("nested/secret", new TextEncoder().encode("private"), { mode: 0o600 });
			if (preservesMode) {
				await write;
				expect(lstatSync(join(rootPath, "nested", "secret")).mode & 0o777).toBe(0o600);
			} else {
				await expect(write).rejects.toThrow("mode not preserved");
				expect(existsSync(join(rootPath, "nested", "secret"))).toBe(false);
			}
		} finally {
			await root.close();
		}
	});

	test("retains the admitted root when its pathname is replaced", async () => {
		const parent = temporaryRoot("descriptor-root");
		const rootPath = join(parent, "root");
		const admitted = join(parent, "admitted");
		const attacker = join(parent, "attacker");
		await Bun.write(join(rootPath, ".seed"), "seed");
		await Bun.write(join(attacker, ".seed"), "attacker");
		const root = await openDescriptorRoot(rootPath);
		renameSync(rootPath, admitted);
		symlinkSync(attacker, rootPath);
		try {
			await root.writeFileAtomic("nested/value.txt", new TextEncoder().encode("safe"), { mode: 0o640 });
			await expect(root.writeFileAtomic("nested/value.txt", new TextEncoder().encode("blocked"))).rejects.toBeTruthy();
			await root.replaceFileAtomic("nested/value.txt", new TextEncoder().encode("replaced"), { mode: 0o640 });
			expect(readFileSync(join(admitted, "nested", "value.txt"), "utf8")).toBe("replaced");
			expect(existsSync(join(attacker, "nested", "value.txt"))).toBe(false);
			expect(lstatSync(join(admitted, "nested", "value.txt")).mode & 0o777).toBe(0o640);
		} finally {
			await root.close();
		}
	});

	test("retains an admitted parent across a deterministic replacement race", async () => {
		const rootPath = temporaryRoot("descriptor-parent");
		await Bun.write(join(rootPath, "parent", ".seed"), "seed");
		await Bun.write(join(rootPath, "attacker", ".seed"), "attacker");
		const root = await openDescriptorRoot(rootPath);
		try {
			await root.writeFileAtomic("parent/value.txt", new TextEncoder().encode("safe"), {
				beforeMutation: async () => {
					renameSync(join(rootPath, "parent"), join(rootPath, "admitted-parent"));
					symlinkSync(join(rootPath, "attacker"), join(rootPath, "parent"));
				},
			});
			expect(readFileSync(join(rootPath, "admitted-parent", "value.txt"), "utf8")).toBe("safe");
			expect(existsSync(join(rootPath, "attacker", "value.txt"))).toBe(false);
		} finally {
			await root.close();
		}
	});

	test("copies regular files and symlinks without following them", async () => {
		const sourcePath = temporaryRoot("descriptor-source");
		const destinationPath = temporaryRoot("descriptor-destination");
		await Bun.write(join(sourcePath, "dir", "file.txt"), "content");
		chmodSync(join(sourcePath, "dir", "file.txt"), 0o600);
		symlinkSync("dir/file.txt", join(sourcePath, "link"));
		const source = await openDescriptorRoot(sourcePath);
		const destination = await openDescriptorRoot(destinationPath);
		try {
			const inventory = await source.inventory();
			expect(inventory.map((entry) => [entry.path, entry.type])).toEqual([
				["dir", "directory"],
				["dir/file.txt", "file"],
				["link", "symlink"],
			]);
			await destination.copyTreeFrom(source);
			expect(readFileSync(join(destinationPath, "dir", "file.txt"), "utf8")).toBe("content");
			expect(lstatSync(join(destinationPath, "dir", "file.txt")).mode & 0o777).toBe(0o600);
			expect(lstatSync(join(destinationPath, "link")).isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(destinationPath, "link"))).toBe("dir/file.txt");
		} finally {
			await destination.close();
			await source.close();
		}
	});

	test("copies to a caller-owned staging name and cleans it when publication stops", async () => {
		const sourcePath = temporaryRoot("descriptor-staged-source");
		const destinationPath = temporaryRoot("descriptor-staged-destination");
		writeFileSync(join(sourcePath, "payload.txt"), "complete bytes");
		const source = await openDescriptorRoot(sourcePath);
		const destination = await openDescriptorRoot(destinationPath);
		const temporaryName = ".signet-migration-test.tmp";
		let reachedPublication = false;
		try {
			await expect(
				destination.copyFileFrom(
					source,
					"payload.txt",
					{
						temporaryName,
						beforePublish: async () => {
							reachedPublication = true;
							expect(existsSync(join(destinationPath, temporaryName))).toBe(true);
							throw new Error("stop before publication");
						},
					},
					"payload.txt",
				),
			).rejects.toThrow("stop before publication");
			expect(reachedPublication).toBe(true);
			expect(existsSync(join(destinationPath, temporaryName))).toBe(false);
			expect(existsSync(join(destinationPath, "payload.txt"))).toBe(false);
		} finally {
			await destination.close();
			await source.close();
		}
	});

	test("keeps the published target and staging link at the pre-cleanup boundary", async () => {
		const sourcePath = temporaryRoot("descriptor-published-source");
		const destinationPath = temporaryRoot("descriptor-published-destination");
		writeFileSync(join(sourcePath, "payload.txt"), "complete bytes");
		const source = await openDescriptorRoot(sourcePath);
		const destination = await openDescriptorRoot(destinationPath);
		const temporaryName = ".signet-migration-published.tmp";
		try {
			await expect(
				destination.copyFileFrom(
					source,
					"payload.txt",
					{
						temporaryName,
						afterPublish: async () => {
							expect(existsSync(join(destinationPath, temporaryName))).toBe(true);
							expect(existsSync(join(destinationPath, "payload.txt"))).toBe(true);
							throw new Error("interrupt after publication");
						},
					},
					"payload.txt",
				),
			).rejects.toThrow("interrupt after publication");
			expect(existsSync(join(destinationPath, temporaryName))).toBe(true);
			expect(lstatSync(join(destinationPath, temporaryName)).ino).toBe(
				lstatSync(join(destinationPath, "payload.txt")).ino,
			);
		} finally {
			await destination.close();
			await source.close();
		}
	});

	test("preserves an existing file when a requested staging name is occupied", async () => {
		const sourcePath = temporaryRoot("descriptor-occupied-source");
		const destinationPath = temporaryRoot("descriptor-occupied-destination");
		writeFileSync(join(sourcePath, "payload.txt"), "source bytes");
		const temporaryName = ".signet-migration-occupied.tmp";
		writeFileSync(join(destinationPath, temporaryName), "unrelated data");
		const source = await openDescriptorRoot(sourcePath);
		const destination = await openDescriptorRoot(destinationPath);
		try {
			await expect(destination.copyFileFrom(source, "payload.txt", { temporaryName }, "payload.txt")).rejects.toThrow();
			expect(readFileSync(join(destinationPath, temporaryName), "utf8")).toBe("unrelated data");
			expect(existsSync(join(destinationPath, "payload.txt"))).toBe(false);
		} finally {
			await destination.close();
			await source.close();
		}
	});

	test("reports hard-link identity and copies files in bounded chunks", async () => {
		const sourcePath = temporaryRoot("descriptor-hardlink-source");
		const destinationPath = temporaryRoot("descriptor-hardlink-destination");
		const bytes = new Uint8Array(3 * 1024 * 1024 + 17);
		bytes.fill(73);
		await Bun.write(join(sourcePath, "large.bin"), bytes);
		linkSync(join(sourcePath, "large.bin"), join(sourcePath, "large-link.bin"));
		const source = await openDescriptorRoot(sourcePath);
		const destination = await openDescriptorRoot(destinationPath);
		try {
			const files = (await source.inventory()).filter((entry) => entry.type === "file");
			expect(files).toHaveLength(2);
			expect(files[0]?.ino).toBe(files[1]?.ino);
			expect(files[0]?.nlink).toBe(2);
			await destination.copyTreeFrom(source);
			expect(readFileSync(join(destinationPath, "large.bin"))).toEqual(Buffer.from(bytes));
			expect(lstatSync(join(destinationPath, "large.bin")).ino).not.toBe(
				lstatSync(join(destinationPath, "large-link.bin")).ino,
			);
		} finally {
			await destination.close();
			await source.close();
		}
	});

	test("rejects escaping paths, final symlinks, and special files", async () => {
		const rootPath = temporaryRoot("descriptor-reject");
		await Bun.write(join(rootPath, "outside"), "outside");
		symlinkSync("outside", join(rootPath, "final"));
		const root = await openDescriptorRoot(rootPath);
		try {
			await expect(root.writeFileAtomic("../escape", new Uint8Array())).rejects.toThrow("escapes");
			await expect(root.writeFileAtomic("final", new Uint8Array())).rejects.toThrow();
			if (process.platform !== "win32") {
				const fifo = Bun.spawnSync(["mkfifo", join(rootPath, "pipe")]);
				expect(fifo.exitCode).toBe(0);
				await expect(root.inventory()).rejects.toThrow("special");
			}
		} finally {
			await root.close();
		}
	});

	test("removes only the admitted tree after pathname replacement", async () => {
		const parent = temporaryRoot("descriptor-remove");
		const rootPath = join(parent, "root");
		const admitted = join(parent, "admitted");
		const attacker = join(parent, "attacker");
		await Bun.write(join(rootPath, "nested", "remove.txt"), "remove");
		await Bun.write(join(attacker, "keep.txt"), "keep");
		const root = await openDescriptorRoot(rootPath);
		renameSync(rootPath, admitted);
		symlinkSync(attacker, rootPath);
		try {
			await root.remove("nested", { recursive: true });
			expect(existsSync(join(admitted, "nested"))).toBe(false);
			expect(readFileSync(join(attacker, "keep.txt"), "utf8")).toBe("keep");
		} finally {
			await root.close();
		}
	});

	test("refuses to remove a target entry replaced after recursive traversal", async () => {
		const rootPath = temporaryRoot("descriptor-target-replacement");
		const admitted = join(rootPath, "admitted");
		await Bun.write(join(rootPath, "target", "remove.txt"), "remove");
		const root = await openDescriptorRoot(rootPath);
		try {
			await expect(
				root.remove("target", {
					recursive: true,
					beforeMutation: async () => {
						renameSync(join(rootPath, "target"), admitted);
						mkdirSync(join(rootPath, "target"));
					},
				}),
			).rejects.toThrow("descriptor removal target changed");
			expect(existsSync(join(rootPath, "target"))).toBe(true);
			expect(existsSync(admitted)).toBe(true);
		} finally {
			await root.close();
		}
	});

	test("reports unsupported descriptor filesystems explicitly", async () => {
		const rootPath = temporaryRoot("descriptor-platform");
		if (process.platform === "linux" || process.platform === "darwin") {
			const root = await openDescriptorRoot(rootPath);
			await root.close();
			return;
		}
		await expect(openDescriptorRoot(rootPath)).rejects.toBeInstanceOf(UnsupportedDescriptorFilesystemError);
	});
});

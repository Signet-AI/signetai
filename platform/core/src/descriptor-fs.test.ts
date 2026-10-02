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
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDescriptorRoot } from "./descriptor-fs";

const roots: string[] = [];

function temporaryRoot(name: string): string {
	const root = mkdtempSync(join(tmpdir(), `${name}-`));
	roots.push(root);
	return root;
}

function tryCreateSymlink(target: string, path: string, type?: "file" | "dir"): boolean {
	try {
		symlinkSync(target, path, type);
		return true;
	} catch (error) {
		if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return false;
		throw error;
	}
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("descriptor-rooted filesystem", () => {
	test("lists immediate names without opening child directories", async () => {
		const rootPath = temporaryRoot("descriptor-shallow-list");
		const inaccessible = join(rootPath, "unrelated");
		mkdirSync(inaccessible);
		writeFileSync(join(inaccessible, "private.bin"), "not part of this listing");
		chmodSync(inaccessible, 0);
		const root = await openDescriptorRoot(rootPath);
		try {
			expect(await root.listNames()).toEqual(["unrelated"]);
		} finally {
			await root.close();
			chmodSync(inaccessible, 0o700);
		}
	});

	test("inspects one named entry without walking sibling directories", async () => {
		const rootPath = temporaryRoot("descriptor-single-entry");
		const inaccessible = join(rootPath, "unrelated");
		mkdirSync(inaccessible);
		writeFileSync(join(inaccessible, "private.bin"), "not part of this inspection");
		chmodSync(inaccessible, 0);
		writeFileSync(join(rootPath, "managed.txt"), "owned");
		const root = await openDescriptorRoot(rootPath);
		try {
			expect(await root.inspectEntry("managed.txt")).toMatchObject({
				path: "managed.txt",
				type: "file",
				size: 5,
			});
		} finally {
			await root.close();
			chmodSync(inaccessible, 0o700);
		}
	});

	test("preserves native file modes and accepts Windows ACL-backed modes", async () => {
		const rootPath = temporaryRoot("descriptor-mode");
		const probe = join(rootPath, "permission-probe");
		writeFileSync(probe, "probe", { mode: 0o600 });
		chmodSync(probe, 0o600);
		const preservesMode = (lstatSync(probe).mode & 0o777) === 0o600;
		const root = await openDescriptorRoot(rootPath);
		try {
			const write = root.writeFileAtomic("nested/secret", new TextEncoder().encode("private"), { mode: 0o600 });
			if (process.platform === "win32" || preservesMode) {
				await write;
				if (process.platform !== "win32")
					expect(lstatSync(join(rootPath, "nested", "secret")).mode & 0o777).toBe(0o600);
			} else {
				await expect(write).rejects.toThrow("mode not preserved");
				expect(existsSync(join(rootPath, "nested", "secret"))).toBe(false);
			}
		} finally {
			await root.close();
		}
	});

	test("preserves Windows read-only file state while destination ACLs remain inherited", async () => {
		if (process.platform !== "win32") return;
		const sourcePath = temporaryRoot("descriptor-readonly-source");
		const destinationPath = temporaryRoot("descriptor-readonly-destination");
		const sourceFile = join(sourcePath, "readonly.txt");
		writeFileSync(sourceFile, "read-only content");
		chmodSync(sourceFile, 0o444);
		const source = await openDescriptorRoot(sourcePath);
		const destination = await openDescriptorRoot(destinationPath);
		try {
			await destination.copyFileFrom(source, "readonly.txt");
			expect(lstatSync(join(destinationPath, "readonly.txt")).mode & 0o222).toBe(0);
		} finally {
			await destination.close();
			await source.close();
			chmodSync(sourceFile, 0o666);
			const destinationFile = join(destinationPath, "readonly.txt");
			if (existsSync(destinationFile)) chmodSync(destinationFile, 0o666);
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
		let recreatedRootIsDecoy = false;
		try {
			if (process.platform === "win32") {
				renameSync(rootPath, admitted);
				if (!tryCreateSymlink(attacker, rootPath)) {
					mkdirSync(join(rootPath, "nested"), { recursive: true });
					writeFileSync(join(rootPath, "nested", "value.txt"), "decoy");
					recreatedRootIsDecoy = true;
				}
			} else {
				renameSync(rootPath, admitted);
				symlinkSync(attacker, rootPath);
			}
			await root.writeFileAtomic("nested/value.txt", new TextEncoder().encode("safe"), { mode: 0o640 });
			await expect(root.writeFileAtomic("nested/value.txt", new TextEncoder().encode("blocked"))).rejects.toBeTruthy();
			await root.replaceFileAtomic("nested/value.txt", new TextEncoder().encode("replaced"), { mode: 0o640 });
			const admittedRoot = admitted;
			expect(readFileSync(join(admittedRoot, "nested", "value.txt"), "utf8")).toBe("replaced");
			expect(existsSync(join(attacker, "nested", "value.txt"))).toBe(false);
			if (recreatedRootIsDecoy) expect(readFileSync(join(rootPath, "nested", "value.txt"), "utf8")).toBe("decoy");
			if (process.platform !== "win32")
				expect(lstatSync(join(admittedRoot, "nested", "value.txt")).mode & 0o777).toBe(0o640);
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
					if (process.platform === "win32") {
						renameSync(join(rootPath, "parent"), join(rootPath, "admitted-parent"));
						tryCreateSymlink(join(rootPath, "attacker"), join(rootPath, "parent"), "dir");
					} else {
						renameSync(join(rootPath, "parent"), join(rootPath, "admitted-parent"));
						symlinkSync(join(rootPath, "attacker"), join(rootPath, "parent"));
					}
				},
			});
			const safePath = join(rootPath, "admitted-parent", "value.txt");
			expect(readFileSync(safePath, "utf8")).toBe("safe");
			expect(existsSync(join(rootPath, "attacker", "value.txt"))).toBe(false);
		} finally {
			await root.close();
		}
	});

	test("refuses to remove a path whose inode differs from the reviewed inventory entry", async () => {
		const rootPath = temporaryRoot("descriptor-remove-identity");
		const originalPath = join(rootPath, "entry.txt");
		const movedPath = join(rootPath, "reviewed-entry.txt");
		writeFileSync(originalPath, "reviewed bytes");
		const root = await openDescriptorRoot(rootPath);
		try {
			const [expected] = await root.inventory();
			if (!expected) throw new Error("expected inventory entry");
			if (process.platform === "win32") expect(expected.nativeIdentity).toMatch(/^windows:[0-9a-f]+:[0-9a-f]{32}$/);
			renameSync(originalPath, movedPath);
			writeFileSync(originalPath, "replacement bytes");
			await expect(root.remove("entry.txt", { expectedEntry: expected })).rejects.toThrow(
				"descriptor removal target changed",
			);
			expect(readFileSync(originalPath, "utf8")).toBe("replacement bytes");
			expect(readFileSync(movedPath, "utf8")).toBe("reviewed bytes");
		} finally {
			await root.close();
		}
	});

	test("copies regular files and symlinks without following them", async () => {
		const sourcePath = temporaryRoot("descriptor-source");
		const destinationPath = temporaryRoot("descriptor-destination");
		await Bun.write(join(sourcePath, "dir", "file.txt"), "content");
		chmodSync(join(sourcePath, "dir", "file.txt"), 0o600);
		const symlinksAvailable = tryCreateSymlink("dir/file.txt", join(sourcePath, "link"));
		if (symlinksAvailable) tryCreateSymlink("dir", join(sourcePath, "link-dir"), "dir");
		const sourceFileMode = lstatSync(join(sourcePath, "dir", "file.txt")).mode & 0o777;
		const source = await openDescriptorRoot(sourcePath);
		const destination = await openDescriptorRoot(destinationPath);
		try {
			const inventory = await source.inventory();
			expect(inventory.map((entry) => [entry.path, entry.type])).toEqual([
				["dir", "directory"],
				["dir/file.txt", "file"],
				...(symlinksAvailable ? [["link", "symlink"]] : []),
				...(symlinksAvailable && existsSync(join(sourcePath, "link-dir")) ? [["link-dir", "symlink"]] : []),
			]);
			await destination.copyTreeFrom(source);
			expect(readFileSync(join(destinationPath, "dir", "file.txt"), "utf8")).toBe("content");
			expect(lstatSync(join(destinationPath, "dir", "file.txt")).mode & 0o777).toBe(sourceFileMode);
			if (symlinksAvailable) {
				expect(lstatSync(join(destinationPath, "link")).isSymbolicLink()).toBe(true);
				expect(readlinkSync(join(destinationPath, "link"))).toBe(join("dir", "file.txt"));
			}
			if (existsSync(join(sourcePath, "link-dir"))) {
				expect(lstatSync(join(destinationPath, "link-dir")).isSymbolicLink()).toBe(true);
				expect(statSync(join(destinationPath, "link-dir")).isDirectory()).toBe(true);
			}
		} finally {
			await destination.close();
			await source.close();
		}
	});

	test("inventories symlink metadata from its parent descriptor", async () => {
		const rootPath = temporaryRoot("descriptor-symlink-inventory");
		writeFileSync(join(rootPath, "target.txt"), "target");
		if (!tryCreateSymlink("target.txt", join(rootPath, "link"))) return;
		const root = await openDescriptorRoot(rootPath);
		try {
			const link = (await root.inventory()).find((entry) => entry.path === "link");
			expect(link).toMatchObject({ type: "symlink", target: "target.txt" });
			expect(link?.ino).toBe(lstatSync(join(rootPath, "link")).ino);
		} finally {
			await root.close();
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
		const finalSymlinkAvailable = tryCreateSymlink("outside", join(rootPath, "final"));
		const root = await openDescriptorRoot(rootPath);
		try {
			await expect(root.writeFileAtomic("../escape", new Uint8Array())).rejects.toThrow("escapes");
			await expect(root.writeFileAtomic("nested/../escape", new Uint8Array())).rejects.toThrow("escapes");
			if (process.platform === "win32")
				await expect(root.writeFileAtomic("..\\escape", new Uint8Array())).rejects.toThrow("escapes");
			if (finalSymlinkAvailable) await expect(root.writeFileAtomic("final", new Uint8Array())).rejects.toThrow();
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
		try {
			if (process.platform === "win32") {
				renameSync(rootPath, admitted);
				mkdirSync(join(rootPath, "nested"), { recursive: true });
				writeFileSync(join(rootPath, "nested", "keep.txt"), "decoy");
			} else {
				renameSync(rootPath, admitted);
				symlinkSync(attacker, rootPath);
			}
			await root.remove("nested", { recursive: true });
			expect(existsSync(join(admitted, "nested"))).toBe(false);
			expect(readFileSync(join(attacker, "keep.txt"), "utf8")).toBe("keep");
			if (process.platform === "win32")
				expect(readFileSync(join(rootPath, "nested", "keep.txt"), "utf8")).toBe("decoy");
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

	test("opens a descriptor root on the current platform", async () => {
		const rootPath = temporaryRoot("descriptor-platform");
		const root = await openDescriptorRoot(rootPath);
		try {
			expect(await root.listNames()).toEqual([]);
		} finally {
			await root.close();
		}
	});
});

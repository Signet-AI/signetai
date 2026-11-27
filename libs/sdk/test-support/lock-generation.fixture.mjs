import { test, afterAll, mock } from "bun:test";
const realFs = { ...(await import("node:fs/promises")) };
afterAll(() => {
	mock.module("node:fs/promises", () => realFs);
});
test("lock generation subprocess contract", async () => {
	if (!process.env.FIXTURE_LOCK) throw new Error("Missing fixture data");
	const { mock } = await import("bun:test");
	const fs = await import("node:fs/promises");
	const native = { ...fs };
	const path = process.env.FIXTURE_LOCK;
	let armed = false,
		swapped = false;
	const replacement = JSON.stringify({
		pid: process.pid,
		token: "replacement",
		startTime: "linux:" + (await native.readFile("/proc/self/stat", "utf8")).split(")").at(-1).trim().split(/\s+/)[19],
		createdAt: Date.now(),
	});
	async function swap() {
		if (!swapped) {
			swapped = true;
			await native.rename(path, path + ".previous");
			await native.writeFile(path, replacement, { mode: 0o600 });
		}
	}
	mock.module("node:fs/promises", () => ({
		...native,
		open: async (...args) => {
			const h = await native.open(...args);
			if (String(args[0]) !== path) return h;
			return new Proxy(h, {
				get(target, key) {
					if (key === "readFile")
						return async (...a) => {
							const text = await target.readFile(...a);
							if (armed && !swapped) await swap();
							return text;
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
		rm: async (p, opts) => {
			if (String(p) === path && armed && !swapped) await swap();
			return native.rm(p, opts);
		},
	}));
	const { withFileLock } = await import("../src/node/storage.ts");
	await withFileLock(path, async () => {
		if (
			await native.stat(path).then(
				() => true,
				() => false,
			)
		) {
			armed = true;
		} else {
			await native.writeFile(path, replacement, { mode: 0o600 });
			swapped = true;
		}
	});
	if (JSON.parse(await native.readFile(path, "utf8")).token !== "replacement")
		throw new Error("replacement owner was deleted");
});

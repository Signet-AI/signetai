import { afterAll, afterEach } from "bun:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as children from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
const journal = join(mkdtempSync(join(tmpdir(), "signet-network-guard-")), "blocked.log");
const preload = join(import.meta.dir, "block-live-daemon.cjs");
const python = join(import.meta.dir, "python");
function record(value) {
	return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
}
export function guardedTestEnvironment(value = process.env) {
	const env = Object.fromEntries(Object.entries(record(value)).filter((entry) => typeof entry[1] === "string"));
	return {
		...env,
		SIGNET_TEST_BLOCKED_FETCHES: journal,
		PYTHONDONTWRITEBYTECODE: "1",
		BUN_OPTIONS: `--preload=${preload} ${env.BUN_OPTIONS ?? ""}`,
		NODE_OPTIONS: `--require ${preload} ${env.NODE_OPTIONS ?? ""}`,
		PYTHONPATH: `${python}${env.PYTHONPATH ? delimiter + env.PYTHONPATH : ""}`,
	};
}
Object.assign(process.env, guardedTestEnvironment());
createRequire(import.meta.url)(preload);
function guardedOptions(value) {
	const options = record(value);
	return { ...options, env: guardedTestEnvironment(options.env ?? process.env) };
}
Bun.spawn = new Proxy(Bun.spawn, {
	apply(target, receiver, args) {
		const updated = [...args];
		if (Array.isArray(updated[0])) updated[1] = guardedOptions(updated[1]);
		else updated[0] = { ...record(updated[0]), ...guardedOptions(updated[0]) };
		return Reflect.apply(target, receiver, updated);
	},
});
Bun.spawnSync = new Proxy(Bun.spawnSync, {
	apply(target, receiver, args) {
		const updated = [...args];
		if (Array.isArray(updated[0])) updated[1] = guardedOptions(updated[1]);
		else updated[0] = { ...record(updated[0]), ...guardedOptions(updated[0]) };
		return Reflect.apply(target, receiver, updated);
	},
});
const require = createRequire(import.meta.url);
const mutableChildren = require("node:child_process");
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
	const original = children[name];
	Reflect.set(
		mutableChildren,
		name,
		new Proxy(original, {
			apply(target, receiver, args) {
				const updated = [...args];
				const index = Array.isArray(updated[1]) ? 2 : 1;
				if (typeof updated[index] !== "function") updated[index] = guardedOptions(updated[index]);
				return Reflect.apply(target, receiver, updated);
			},
		}),
	);
}
syncBuiltinESMExports();
function assertNoLiveRequests() {
	if (!existsSync(journal)) return;
	const blocked = readFileSync(journal, "utf8");
	writeFileSync(journal, "");
	if (blocked)
		throw new Error(`Test attempted the live daemon; network was blocked:
${blocked}`);
}
afterEach(assertNoLiveRequests);
afterAll(assertNoLiveRequests);

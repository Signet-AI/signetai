import { test, afterAll, mock } from "bun:test";
const realFs = { ...(await import("node:fs/promises")) };
afterAll(() => {
	mock.module("node:fs/promises", () => realFs);
});
test("login durability subprocess contract", async () => {
	if (!process.env.FIXTURE_OPERATION) throw new Error("Missing fixture data");
	const { mock } = await import("bun:test");
	const fs = await import("node:fs/promises");
	const { dirname } = await import("node:path");
	const realRm = fs.rm,
		realOpen = fs.open;
	let statePath = "",
		removed = false;
	mock.module("node:fs/promises", () => ({
		...fs,
		rm: async (path, opts) => {
			await realRm(path, opts);
			if (path === statePath) removed = true;
		},
		open: async (...args) => {
			const h = await realOpen(...args);
			const sync = h.sync.bind(h);
			h.sync = async () => {
				if (removed && args[0] === dirname(statePath)) throw new Error("marker deletion unconfirmed");
				return sync();
			};
			return h;
		},
	}));
	const { LoginStore } = await import("../src/node/login.ts");
	const store = new LoginStore("https://remote.example", {
		env: { HOME: process.env.HOME },
		keyring: { get: async () => ({ state: "missing" }), set: async () => ({ state: "unavailable" }) },
	});
	const value = {
		accessToken: "fixture",
		refreshToken: "fixture-refresh",
		accessExpiresAt: "2099-01-01T00:00:00Z",
		refreshExpiresAt: "2099-01-02T00:00:00Z",
	};
	await store.save(value);
	statePath = store.path + ".state";
	await fs.writeFile(statePath, JSON.stringify({ state: "dead", reason: "revoked" }), { mode: 0o600 });
	let refused = false;
	try {
		await store[process.env.FIXTURE_OPERATION](...(process.env.FIXTURE_OPERATION === "save" ? [value] : []));
	} catch (e) {
		refused = e.message === "marker deletion unconfirmed";
	}
	if (!refused) throw new Error("unconfirmed marker deletion acknowledged");
});

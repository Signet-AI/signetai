const { appendFileSync } = require("node:fs");
const original = globalThis.fetch;
if (original) {
	const check = (input) => {
		const value = typeof input === "string" || input instanceof URL ? String(input) : input.url;
		const url = new URL(value);
		if (url.port !== "3850") return;
		const journal = process.env.SIGNET_TEST_BLOCKED_FETCHES;
		if (journal) appendFileSync(journal, "Blocked test request to port 3850\n");
		throw new Error("Tests must never request the live daemon on port 3850");
	};
	const guarded = Object.assign(
		(input, init) => {
			check(input);
			return original(input, init);
		},
		{
			preconnect: (url, options) => {
				check(url);
				return original.preconnect?.(url, options);
			},
		},
	);
	globalThis.fetch = guarded;
}

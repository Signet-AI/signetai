import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
import { getSecretKeyring } from "../../../platform/core/src/secrets-keyring";
import { diagnoseHermesIntegration } from "../../../integrations/hermes-agent/connector/src/index";
import { countTokens } from "../../../platform/daemon/src/pipeline/tokenizer";
import { DreamingBacklogTokenCache } from "../../../platform/daemon/src/pipeline/dreaming-token-cache";

async function main(): Promise<void> {
	const workspace = process.env.SIGNET_PATH;
	const daemonUrl = process.env.SIGNET_DAEMON_URL;
	if (!workspace || !daemonUrl) throw new Error("Runtime diagnostics require an explicit workspace and daemon URL");
	const keyring = getSecretKeyring(workspace);
	const before = await keyring.get();
	if (before.state !== "missing")
		throw new Error(
			`Disposable keyring account is not empty and available: ${before.state}: ${before.message ?? "no detail"}`,
		);
	const entry = new AsyncEntry(
		keyring.service,
		keyring.account,
		process.platform === "linux" ? { linux: { store: "secret-service" } } : undefined,
	);
	try {
		const value = randomUUID();
		const written = await keyring.set(value);
		if (written.state !== "found")
			throw new Error(`Native keyring write failed: ${written.state}: ${written.message ?? "no detail"}`);
		const read = await keyring.get();
		if (read.state !== "found" || read.value !== value) throw new Error("Native keyring round trip failed");
	} finally {
		await entry.deleteCredential();
	}
	if ((await keyring.get()).state !== "missing") throw new Error("Native keyring cleanup failed");
	const tokens = countTokens("Installed desktop tokenizer round trip");
	if (!Number.isSafeInteger(tokens) || tokens < 1) throw new Error("Tokenizer WASM did not encode text");
	const cache = new DreamingBacklogTokenCache();
	try {
		const worker = await cache.countEntries("default", [
			{ key: "installed-smoke", revision: "1", text: "Installed desktop worker round trip" },
		]);
		if (worker.entriesCounted !== 1 || worker.tokens < 1)
			throw new Error("Built tokenizer worker did not return an exact count");
	} finally {
		cache.stop();
	}
	const connector = await diagnoseHermesIntegration({
		targetRoot: workspace,
		hermesHome: join(workspace, "hermes-home"),
		daemonUrl,
		hermesRepo: null,
	});
	const packaged = connector.checks.find((check) => check.id === "plugin-source");
	if (!packaged?.ok) throw new Error(`Packaged connector inspection failed: ${packaged?.detail}`);
	console.log(
		JSON.stringify({
			keyring: "round-trip-cleaned",
			tokenizer: tokens,
			worker: "exact",
			connector: "packaged-assets-found",
		}),
	);
}

await main();

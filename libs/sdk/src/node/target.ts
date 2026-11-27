import { resolveSignetDaemonUrl } from "@signet/core/daemon-url";
import { isIP } from "node:net";
import { LoginStore, type LoginStoreOptions } from "./login.js";
import { ConnectorRegistry, readKeyFile } from "./registry.js";
import { identifier } from "./storage.js";
import type { RequestControl } from "../transport.js";

export interface ResolveTargetOptions extends LoginStoreOptions {
	readonly harness?: string;
	readonly flagUrl?: string;
	readonly flagKey?: string;
	readonly configUrl?: string;
}
export interface TargetCredential {
	readonly source: "flag" | "env" | "key-file" | "keychain" | "login-file" | "none";
	readonly reason?: string | null;
	get(control?: RequestControl): Promise<string | null>;
	refresh?(rejectedToken: string | null, control?: RequestControl): Promise<string>;
}
export interface ResolvedTarget {
	readonly harness?: string;
	readonly url: string;
	readonly origin: string;
	readonly credential: TargetCredential;
	readonly remote: boolean;
}
export async function resolveTarget(options: ResolveTargetOptions = {}): Promise<ResolvedTarget> {
	const harness = identifier(options.harness ?? "cli");
	const env = options.env ?? process.env;
	const flagUrl = options.flagUrl?.trim();
	if (options.flagUrl !== undefined && !flagUrl) throw new TypeError("flagUrl cannot be empty");
	const envUrl = env.SIGNET_DAEMON_URL?.trim();
	const entries =
		options.harness && !(flagUrl && options.flagKey !== undefined) ? await new ConnectorRegistry(options).read() : {};
	const registry = options.harness && Object.hasOwn(entries, options.harness) ? entries[options.harness] : undefined;

	const hasEnvironmentBinding = Boolean(env.SIGNET_HOST?.trim() || env.SIGNET_PORT?.trim());
	const selectedUrl = flagUrl || registry?.url || envUrl || (!hasEnvironmentBinding ? options.configUrl : undefined);
	const url = resolveSignetDaemonUrl({ env: { ...env, SIGNET_DAEMON_URL: selectedUrl } });
	const origin = new URL(url).origin;
	if (new URL(url).protocol !== "https:" && !isLoopback(new URL(url).hostname))
		throw new TypeError("Remote Signet targets require HTTPS; plain HTTP is allowed only on loopback");
	const hasEnvironmentCredential = Boolean(env.SIGNET_API_KEY?.trim() || env.SIGNET_API_KEY_FILE?.trim());
	const environmentCredentialApplies =
		options.flagKey !== undefined ||
		!hasEnvironmentCredential ||
		(!envUrl && !flagUrl) ||
		Boolean(envUrl && new URL(resolveSignetDaemonUrl({ env: { SIGNET_DAEMON_URL: envUrl } })).origin === origin);
	let credential: TargetCredential;
	if (options.flagKey !== undefined) {
		if (!options.flagKey.trim()) throw new TypeError("flagKey cannot be empty");
		const key = options.flagKey.trim();
		credential = { source: "flag", get: async () => key };
	} else if (environmentCredentialApplies && env.SIGNET_API_KEY?.trim()) {
		const key = env.SIGNET_API_KEY.trim();
		credential = { source: "env", get: async () => key };
	} else {
		const keyFile =
			(environmentCredentialApplies ? env.SIGNET_API_KEY_FILE?.trim() : undefined) ||
			(registry && new URL(registry.url).origin === origin ? registry.keyFile : undefined);
		if (keyFile) {
			await readKeyFile(keyFile);
			credential = { source: "key-file", get: () => readKeyFile(keyFile) };
		} else {
			const store = new LoginStore(origin, options);
			await store.load();
			credential = {
				get source() {
					return store.source;
				},
				get reason() {
					return store.reason;
				},
				get: (control) => store.accessToken(control),
				refresh: (rejected, control) => store.refresh(rejected, control),
			};
		}
	}
	return {
		url,
		harness,
		origin,
		credential,
		remote: credential.source !== "none" || !isLoopback(new URL(url).hostname),
	};
}

function isLoopback(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "[::1]" ||
		(isIP(hostname) === 4 && hostname.startsWith("127.")) ||
		/^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname)
	);
}

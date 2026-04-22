import { getLocalSecretProviderHealth } from "../secrets.js";
import { signetGraphiqManifest } from "./bundled/graphiq.js";
import { SIGNET_SECRETS_PLUGIN_ID, signetSecretsManifest } from "./bundled/secrets.js";
import { PluginHostV1 } from "./host.js";
import type { PluginHostOptionsV1 } from "./host.js";

let defaultHost: PluginHostV1 | null = null;

export function createDefaultPluginHost(opts: PluginHostOptionsV1 = {}): PluginHostV1 {
	const host = new PluginHostV1({
		corePluginIds: [SIGNET_SECRETS_PLUGIN_ID],
		...opts,
	});
	host.discover(signetSecretsManifest, {
		source: "bundled",
		enabled: true,
		grantedCapabilities: signetSecretsManifest.capabilities,
		health: getLocalSecretProviderHealth(),
	});
	host.discover(signetGraphiqManifest, {
		source: "bundled",
		enabled: false,
		grantedCapabilities: signetGraphiqManifest.capabilities,
	});
	return host;
}

export function getDefaultPluginHost(): PluginHostV1 {
	if (!defaultHost) {
		defaultHost = createDefaultPluginHost();
	}
	return defaultHost;
}

export function resetDefaultPluginHostForTests(): void {
	defaultHost = null;
}

export { SIGNET_SECRETS_PLUGIN_ID, signetSecretsManifest } from "./bundled/secrets.js";
export { SIGNET_GRAPHIQ_PLUGIN_ID, signetGraphiqManifest } from "./bundled/graphiq.js";
export { getDefaultPluginAuditPath, queryPluginAuditEvents, recordPluginAuditEvent } from "./audit.js";
export { PluginHostV1, getDefaultPluginRegistryPath } from "./host.js";
export { runtimeSupportedInV1, unsupportedRuntimeReason, validatePluginManifest } from "./manifest.js";
export type * from "./audit.js";
export type * from "./types.js";

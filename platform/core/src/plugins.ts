import { join } from "node:path";
import { resolveWorkspaceLayout } from "./workspace-layout";

export const SIGNET_SECRETS_PLUGIN_ID = "signet.secrets";
export const SIGNET_GRAPHIQ_PLUGIN_ID = "signet.graphiq";
export const SIGNET_PLUGIN_REGISTRY_FILE = "registry-v1.json";
export const SIGNET_PLUGIN_REGISTRY_VERSION = 1;

export function getPluginRegistryDir(basePath: string): string {
	return join(resolveWorkspaceLayout(basePath).runtime, "plugins");
}

export function getPluginRegistryPath(basePath: string): string {
	return join(getPluginRegistryDir(basePath), SIGNET_PLUGIN_REGISTRY_FILE);
}

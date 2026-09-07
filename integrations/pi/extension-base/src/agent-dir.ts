import { createAgentDir } from "@signet/connector-base/agent-dir";

const piAgentDir = createAgentDir({
	configFileName: "pi.json",
	defaultAgentDir: ".pi/agent",
	managedFileNames: ["signet-pi.js", "signet-pi.mjs"],
	managedMarker: "SIGNET_MANAGED_PI_EXTENSION",
});

export const clearConfiguredPiAgentDir = piAgentDir.clearConfiguredAgentDir;
export const getPiConfigPath = piAgentDir.getConfigPath;
export const hasPiSetup = piAgentDir.hasSetup;
export const listPiAgentDirCandidates = piAgentDir.listAgentDirCandidates;
export const readConfiguredPiAgentDir = piAgentDir.readConfiguredAgentDir;
export const resolvePiAgentDir = piAgentDir.resolveAgentDir;
export const resolvePiExtensionsDir = piAgentDir.resolveExtensionsDir;
export const writeConfiguredPiAgentDir = piAgentDir.writeConfiguredAgentDir;

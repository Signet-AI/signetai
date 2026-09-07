import { createAgentDir } from "@signet/connector-base/agent-dir";

const ohMyPiAgentDir = createAgentDir({
	configFileName: "oh-my-pi.json",
	defaultAgentDir: ".omp/agent",
});

export const clearConfiguredOhMyPiAgentDir = ohMyPiAgentDir.clearConfiguredAgentDir;
export const getOhMyPiConfigPath = ohMyPiAgentDir.getConfigPath;
export const hasOhMyPiSetup = ohMyPiAgentDir.hasSetup;
export const listOhMyPiAgentDirCandidates = ohMyPiAgentDir.listAgentDirCandidates;
export const readConfiguredOhMyPiAgentDir = ohMyPiAgentDir.readConfiguredAgentDir;
export const resolveOhMyPiAgentDir = ohMyPiAgentDir.resolveAgentDir;
export const resolveOhMyPiExtensionsDir = ohMyPiAgentDir.resolveExtensionsDir;
export const writeConfiguredOhMyPiAgentDir = ohMyPiAgentDir.writeConfiguredAgentDir;

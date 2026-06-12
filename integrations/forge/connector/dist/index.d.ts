import { BaseConnector, type InstallResult, type UninstallResult } from "@signet/connector-base";
export declare class ForgeConnector extends BaseConnector {
    readonly name = "ForgeCode";
    readonly harnessId = "forge";
    private getForgeHome;
    private getAgentsPath;
    private getSkillsPath;
    private getMcpConfigPath;
    getConfigPath(): string;
    install(basePath: string): Promise<InstallResult>;
    uninstall(): Promise<UninstallResult>;
    isInstalled(): boolean;
    private extractSignetPath;
    private removeSkillSymlinks;
    private generateAgentsMd;
    private registerMcpServer;
    private removeMcpServer;
}

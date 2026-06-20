import { BaseConnector, type InstallResult, type UninstallResult } from "@signet/connector-base";
export declare class ForgeConnector extends BaseConnector {
    readonly name = "ForgeCode";
    readonly harnessId = "forge";
    protected getForgeHome(): string;
    getConfigPath(): string;
    install(basePath: string): Promise<InstallResult>;
    uninstall(): Promise<UninstallResult>;
    isInstalled(): boolean;
    static isHarnessInstalled(): boolean;
    private getAgentsPath;
    private getSkillsPath;
    private getMcpConfigPath;
    private generateAgentsMd;
    private registerMcpServer;
    private removeMcpServer;
    private extractSignetPath;
    private removeSkillSymlinks;
}
export declare const forgeConnector: ForgeConnector;
export default ForgeConnector;
//# sourceMappingURL=index.d.ts.map
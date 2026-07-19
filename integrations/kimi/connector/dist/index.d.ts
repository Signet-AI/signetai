/**
 * Signet Connector for Kimi CLI / Kimi Code
 *
 * Integrates Signet's memory system with Kimi's lifecycle hooks.
 *
 * Kimi facts (from the official Kimi Code docs):
 * - Config home: ~/.kimi-code/ (env override KIMI_CODE_HOME)
 * - Hooks: [[hooks]] array-of-tables in ~/.kimi-code/config.toml.
 *   Allowed fields: event (required), matcher (optional regex),
 *   command (required), timeout (optional). Extra fields break config load.
 * - Hook payload arrives as JSON on STDIN (snake_case fields).
 * - For UserPromptSubmit, hook STDOUT text is appended to the model context;
 *   SessionStart STDOUT is also appended. SessionEnd is observation-only.
 * - MCP servers: JSON file ~/.kimi-code/mcp.json with shape
 *   {"mcpServers": {"signet": {"command": ..., "args": [...]}}} for stdio.
 *
 * Usage:
 * ```typescript
 * import { KimiConnector } from '@signet/connector-kimi';
 *
 * const connector = new KimiConnector();
 * await connector.install('~/.agents');
 * ```
 */
import { BaseConnector, type InstallResult, type UninstallResult } from "@signet/connector-base";
export interface KimiMcpStdioConfig {
    readonly command: string;
    readonly args: readonly string[];
}
export interface KimiHookEntry {
    readonly event: "SessionStart" | "UserPromptSubmit" | "SessionEnd";
    readonly command: string;
    readonly timeout: number;
}
export declare function buildKimiHookEntries(signetArgs: readonly string[], remoteDaemonUrl?: string | null): KimiHookEntry[];
/** Remove every Signet-owned Kimi [[hooks]] block (and its marker comment)
 *  from config.toml content. User-owned hooks and other sections are kept. */
export declare function removeSignetKimiHookBlocks(content: string): string;
export declare class KimiConnector extends BaseConnector {
    readonly name = "Kimi";
    readonly harnessId = "kimi";
    protected getKimiHome(): string;
    getConfigPath(): string;
    protected getMcpJsonPath(): string;
    install(basePath: string): Promise<InstallResult>;
    uninstall(): Promise<UninstallResult>;
    isInstalled(): boolean;
}
export default KimiConnector;
//# sourceMappingURL=index.d.ts.map
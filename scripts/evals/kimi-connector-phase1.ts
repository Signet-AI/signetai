import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiConnector } from "../../integrations/kimi/connector/src/index.js";

class EvalConnector extends KimiConnector {
	constructor(private readonly home: string) {
		super();
	}

	protected override getKimiHome(): string {
		return join(this.home, "kimi");
	}
}

interface EvalCheck {
	readonly name: string;
	readonly pass: boolean;
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "signet-kimi-eval-"));
	try {
		const kimiHome = join(root, "kimi");
		const configPath = join(kimiHome, "config.toml");
		const mcpPath = join(kimiHome, "mcp.json");
		mkdirSync(kimiHome, { recursive: true });
		writeFileSync(
			configPath,
			[
				"model = 'kimi-k2.7'",
				"",
				"[[hooks]]",
				"event = 'PreToolUse'",
				"command = 'echo user-hook'",
				"timeout = 5",
				"",
				"[providers]",
				"default = 'moonshot'",
				"",
				"[mcp.client]",
				"tool_call_timeout_ms = 45000",
				"",
			].join("\n"),
		);
		writeFileSync(
			mcpPath,
			JSON.stringify({
				mcpServers: { other: { command: "other-mcp", args: ["--flag"] } },
				theme: "dark",
			}),
		);

		const connector = new EvalConnector(root);
		await connector.install(root);
		const firstConfig = readFileSync(configPath, "utf-8");
		const firstMcp = readFileSync(mcpPath, "utf-8");
		await connector.install(root);
		const secondConfig = readFileSync(configPath, "utf-8");
		const secondMcp = readFileSync(mcpPath, "utf-8");

		const checks: EvalCheck[] = [
			{
				name: "managed lifecycle hooks are exactly three",
				pass: (firstConfig.match(/signet hook .* -H kimi/g) ?? []).length === 3,
			},
			{ name: "user TOML hook is preserved", pass: firstConfig.includes("echo user-hook") },
			{
				name: "provider and MCP TOML tables are preserved",
				pass: firstConfig.includes("default = 'moonshot'") && firstConfig.includes("tool_call_timeout_ms = 45000"),
			},
			{
				name: "existing MCP server is preserved and Signet is added",
				pass: firstMcp.includes('"other"') && firstMcp.includes('"signet"') && firstMcp.includes('"theme"'),
			},
			{ name: "install is idempotent", pass: firstConfig === secondConfig && firstMcp === secondMcp },
		];
		const passed = checks.filter((check) => check.pass).length;
		const report = { pass: passed === checks.length, score: `${passed}/${checks.length}`, checks };
		console.log(JSON.stringify(report, null, 2));
		if (!report.pass) process.exitCode = 1;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

await main();

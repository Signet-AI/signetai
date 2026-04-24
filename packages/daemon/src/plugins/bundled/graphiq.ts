import { SIGNET_GRAPHIQ_PLUGIN_ID } from "@signet/core";
import type { PluginManifestV1, PluginSurfaceDeclarationsV1 } from "../types.js";

export { SIGNET_GRAPHIQ_PLUGIN_ID };

const GRAPHIQ_CAPABILITIES = [
	"code:index",
	"code:search",
	"code:context",
	"code:blast",
	"code:status",
	"code:doctor",
	"code:dead-code",
	"prompt:contribute:user-prompt-submit",
	"mcp:tool",
	"cli:command",
] as const;

const surfaces: PluginSurfaceDeclarationsV1 = {
	daemonRoutes: [],
	cliCommands: [
		{ path: ["index"], summary: "Index a project with GraphIQ", requiredCapabilities: ["cli:command", "code:index"] },
		{
			path: ["graphiq", "status"],
			summary: "Show GraphIQ status for the active project",
			requiredCapabilities: ["cli:command", "code:status"],
		},
		{
			path: ["graphiq", "doctor"],
			summary: "Diagnose the active GraphIQ index",
			requiredCapabilities: ["cli:command", "code:doctor"],
		},
		{
			path: ["graphiq", "upgrade-index"],
			summary: "Rebuild stale GraphIQ artifacts",
			requiredCapabilities: ["cli:command", "code:doctor"],
		},
		{
			path: ["graphiq", "dead-code"],
			summary: "Find unreachable code in the active project",
			requiredCapabilities: ["cli:command", "code:dead-code"],
		},
	],
	mcpTools: [
		{
			name: "signet_code_search",
			title: "Search Code",
			summary: "Search the active GraphIQ-indexed project",
			requiredCapabilities: ["mcp:tool", "code:search"],
		},
		{
			name: "signet_code_context",
			title: "Code Context",
			summary: "Read source and structural neighborhood for a symbol",
			requiredCapabilities: ["mcp:tool", "code:context"],
		},
		{
			name: "signet_code_blast",
			title: "Code Blast Radius",
			summary: "Analyze forward/backward impact for a symbol",
			requiredCapabilities: ["mcp:tool", "code:blast"],
		},
		{
			name: "signet_code_status",
			title: "Code Index Status",
			summary: "Show GraphIQ status for the active project",
			requiredCapabilities: ["mcp:tool", "code:status"],
		},
		{
			name: "signet_code_doctor",
			title: "Code Index Doctor",
			summary: "Diagnose active GraphIQ index health",
			requiredCapabilities: ["mcp:tool", "code:doctor"],
		},
		{
			name: "signet_code_constants",
			title: "Code Constants",
			summary: "Find shared numeric and string constants in code",
			requiredCapabilities: ["mcp:tool", "code:search"],
		},
		{
			name: "signet_code_dead_code",
			title: "Dead Code Detection",
			summary: "Find unreachable symbols in the active project",
			requiredCapabilities: ["mcp:tool", "code:dead-code"],
		},
	],
	dashboardPanels: [],
	sdkClients: [],
	connectorCapabilities: [
		{
			id: "claude-code",
			title: "Claude Code",
			summary: "MCP tools via signet-mcp stdio",
			requiredCapabilities: ["mcp:tool"],
		},
		{
			id: "opencode",
			title: "OpenCode",
			summary: "MCP tools via signet-mcp stdio",
			requiredCapabilities: ["mcp:tool"],
		},
		{ id: "codex", title: "Codex CLI", summary: "MCP tools via signet-mcp stdio", requiredCapabilities: ["mcp:tool"] },
		{
			id: "gemini",
			title: "Gemini CLI",
			summary: "MCP tools via signet-mcp stdio",
			requiredCapabilities: ["mcp:tool"],
		},
		{
			id: "openclaw",
			title: "OpenClaw",
			summary: "MCP tools via signet-mcp stdio",
			requiredCapabilities: ["mcp:tool"],
		},
		{ id: "forge", title: "Forge", summary: "MCP tools via signet-mcp stdio", requiredCapabilities: ["mcp:tool"] },
		{
			id: "hermes-agent",
			title: "Hermes Agent",
			summary: "MCP tools via signet-mcp stdio",
			requiredCapabilities: ["mcp:tool"],
		},
		{
			id: "oh-my-pi",
			title: "Oh My Pi",
			summary: "MCP tools via signet-mcp stdio",
			requiredCapabilities: ["mcp:tool"],
		},
		{ id: "pi", title: "Pi", summary: "MCP tools via signet-mcp stdio", requiredCapabilities: ["mcp:tool"] },
	],
	promptContributions: [
		{
			id: "signet.graphiq.code-retrieval-guidance",
			target: "user-prompt-submit",
			mode: "context",
			priority: 430,
			maxTokens: 100,
			summary: "Advise agents to use GraphIQ for code structure and implementation context",
			requiredCapabilities: ["prompt:contribute:user-prompt-submit"],
		},
	],
};

export const signetGraphiqManifest: PluginManifestV1 = {
	id: SIGNET_GRAPHIQ_PLUGIN_ID,
	name: "GraphIQ Code Retrieval",
	version: "1.0.0",
	publisher: "aaf2tbz",
	description: "Optional verified managed plugin for fast local structural code retrieval through GraphIQ.",
	runtime: {
		language: "typescript",
		kind: "host-managed",
	},
	compatibility: {
		signet: ">=0.103.0 <1.0.0",
		pluginApi: "1.x",
	},
	trustTier: "verified",
	capabilities: GRAPHIQ_CAPABILITIES,
	surfaces,
	marketplace: {
		categories: ["code", "retrieval", "mcp"],
		license: "MIT",
		repository: "https://github.com/aaf2tbz/graphiq",
		homepage: "https://github.com/aaf2tbz/graphiq",
		checksum: null,
		signature: null,
	},
	docs: {
		homepage: "https://github.com/aaf2tbz/graphiq",
		capabilities: {
			"code:index": { summary: "Index a project into its local .graphiq database" },
			"code:search": { summary: "Search indexed code and constants" },
			"code:context": { summary: "Read source and structural symbol context" },
			"code:blast": { summary: "Analyze symbol blast radius" },
			"code:status": { summary: "Inspect active code index status" },
			"code:doctor": { summary: "Diagnose or repair active code index artifacts" },
			"code:dead-code": { summary: "Detect unreachable code in indexed projects" },
			"prompt:contribute:user-prompt-submit": {
				summary: "Contribute bounded guidance for code retrieval decisions",
			},
			"mcp:tool": { summary: "Expose generic code retrieval MCP tools" },
			"cli:command": { summary: "Expose Signet CLI commands for GraphIQ" },
		},
	},
	promptContributions: [
		{
			id: "signet.graphiq.code-retrieval-guidance",
			pluginId: SIGNET_GRAPHIQ_PLUGIN_ID,
			target: "user-prompt-submit",
			mode: "context",
			priority: 430,
			maxTokens: 100,
			content:
				"When working in an indexed codebase, prefer the generic code_* tools for code symbol search, structural context, constants, and blast-radius analysis. GraphIQ indexes live in the project .graphiq directory; Signet only tracks the active indexed project.",
		},
	],
};

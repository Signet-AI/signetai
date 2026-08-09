// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
	output: "static",
	site: "https://docs.signetai.sh",
	integrations: [
		starlight({
			title: "Signet Docs",
			logo: {
				light: "./src/assets/Signet-Logo-Black.png",
				dark: "./src/assets/Signet-Logo-White.png",
				alt: "Signet",
			},
			description: "Install, use, operate, and extend Signet.",
			favicon: "/favicon.svg",
			customCss: ["./src/styles/custom.css"],
			lastUpdated: true,
			editLink: {
				baseUrl: "https://github.com/Signet-AI/signetai/edit/main/web/docs/",
			},
			social: [
				{ icon: "github", label: "GitHub", href: "https://github.com/Signet-AI/signetai" },
				{ icon: "discord", label: "Discord", href: "https://discord.gg/pHa5scah9C" },
			],
			head: [
				{
					tag: "link",
					attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
				},
				{
					tag: "link",
					attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "anonymous" },
				},
				{
					tag: "link",
					attrs: {
						rel: "stylesheet",
						href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap",
					},
				},
			],
			sidebar: [
				{ label: "Quickstart", slug: "quickstart" },
				{ label: "What is Signet", slug: "what-is-signet" },
				{
					label: "Getting Started",
					collapsed: true,
					items: [
						{ label: "Install", slug: "getting-started/install" },
						{ label: "Set up Signet", slug: "getting-started/setup" },
						{ label: "Connect a harness", slug: "harnesses" },
						{ label: "Your first session", slug: "getting-started/first-session" },
						{ label: "Operate your installation", slug: "getting-started/operate" },
						{ label: "Upgrade", slug: "upgrading" },
					],
				},
				{
					label: "Using Signet",
					collapsed: true,
					items: [
						{ label: "Dashboard", slug: "dashboard" },
						{ label: "Memory and recall", slug: "memory" },
						{ label: "Sources", slug: "sources" },
						{ label: "Documents", slug: "documents" },
						{ label: "Skills", slug: "skills" },
						{ label: "Secrets", slug: "secrets" },
						{ label: "Scheduled tasks", slug: "scheduling" },
						{ label: "Hermes and OpenClaw", slug: "ai-memory-hermes-openclaw" },
					],
				},
				{
					label: "Concepts",
					collapsed: true,
					items: [
						{ label: "Knowledge architecture", slug: "knowledge-architecture" },
						{ label: "Knowledge graph", slug: "knowledge-graph" },
						{
							label: "Memory pipeline",
							collapsed: true,
							items: [
								{ label: "Overview", slug: "pipeline" },
								{ label: "Extraction and decisions", slug: "pipeline/extraction-decisions" },
								{ label: "Knowledge and search", slug: "pipeline/knowledge-search" },
								{ label: "Workers and maintenance", slug: "pipeline/workers-maintenance" },
								{ label: "Continuity and lineage", slug: "pipeline/continuity-lineage" },
								{ label: "Configuration reference", slug: "pipeline/configuration" },
							],
						},
						{ label: "Hooks", slug: "hooks" },
						{ label: "Procedural memory", slug: "procedural-memory" },
						{ label: "Memory skills", slug: "memory-skills" },
						{ label: "North Star ontology", slug: "north-star-ontology" },
					],
				},
				{
					label: "Operate",
					collapsed: true,
					items: [
						{
							label: "Configuration",
							collapsed: true,
							items: [
								{ label: "Overview", slug: "configuration" },
								{ label: "Workspace and identity", slug: "configuration/workspace-identity" },
								{ label: "Inference and routing", slug: "configuration/inference-routing" },
								{ label: "Pipeline", slug: "configuration/pipeline" },
								{ label: "Security and lifecycle", slug: "configuration/security-lifecycle" },
								{ label: "Files and integrations", slug: "configuration/files-integrations" },
							],
						},
						{ label: "Authentication", slug: "auth" },
						{ label: "Self-hosting", slug: "self-hosting" },
						{ label: "Remote connectors", slug: "remote-connectors" },
						{ label: "Diagnostics", slug: "diagnostics" },
						{ label: "Analytics", slug: "analytics" },
					],
				},
				{
					label: "Reference",
					collapsed: true,
					items: [
						{
							label: "CLI",
							collapsed: true,
							items: [
								{ label: "Overview", slug: "cli" },
								{ label: "Install and configure", slug: "cli/getting-started" },
								{ label: "Memory and search", slug: "cli/memory-search" },
								{ label: "Runtime operations", slug: "cli/operations" },
								{ label: "Data and portability", slug: "cli/data-portability" },
								{ label: "Integrations and security", slug: "cli/integrations-security" },
								{ label: "Environment and exit codes", slug: "cli/environment" },
							],
						},
						{
							label: "HTTP API",
							collapsed: true,
							items: [
								{ label: "Overview", slug: "api" },
								{ label: "Health and status", slug: "api/health-status" },
								{ label: "Inference", slug: "api/inference" },
								{ label: "Core configuration", slug: "api/core-configuration" },
								{
									label: "Memory",
									collapsed: true,
									items: [
										{ label: "Overview", slug: "api/memory" },
										{ label: "Write lifecycle", slug: "api/memory/write-lifecycle" },
										{ label: "Recall and search", slug: "api/memory/recall-search" },
										{ label: "Embeddings", slug: "api/memory/embeddings" },
									],
								},
								{ label: "Documents and sources", slug: "api/documents-sources" },
								{ label: "Runtime extensions", slug: "api/runtime-extensions" },
								{ label: "Sessions and hooks", slug: "api/sessions-hooks" },
								{ label: "Operations", slug: "api/operations" },
								{ label: "Knowledge and ontology", slug: "api/knowledge-ontology" },
								{ label: "Telemetry and logs", slug: "api/telemetry-logs" },
								{ label: "Route inventory", slug: "api/route-inventory" },
							],
						},
						{
							label: "SDK",
							collapsed: true,
							items: [
								{ label: "Overview", slug: "sdk" },
								{ label: "Quickstart", slug: "sdk/getting-started" },
								{ label: "Core client", slug: "sdk/core-client" },
								{ label: "Integrations", slug: "sdk/integrations" },
								{ label: "Operations", slug: "sdk/operations" },
								{ label: "Knowledge and agents", slug: "sdk/knowledge-agents" },
								{ label: "Types and migration", slug: "sdk/types-migration" },
							],
						},
						{ label: "MCP server", slug: "mcp" },
						{ label: "Daemon", slug: "daemon" },
						{ label: "Connectors", slug: "connectors" },
						{
							label: "Harnesses",
							collapsed: true,
							items: [
								{ label: "Overview", slug: "harnesses" },
								{ label: "Claude Code", slug: "harnesses/claude-code" },
								{ label: "Codex", slug: "harnesses/codex" },
								{ label: "OpenCode", slug: "harnesses/opencode" },
								{ label: "Oh My Pi", slug: "harnesses/oh-my-pi" },
								{ label: "Pi", slug: "harnesses/pi" },
								{ label: "OpenClaw", slug: "harnesses/openclaw" },
								{ label: "Hermes Agent", slug: "harnesses/hermes-agent" },
								{ label: "Develop an integration", slug: "harnesses/develop" },
							],
						},
					],
				},
				{
					label: "Develop",
					collapsed: true,
					items: [
						{
							label: "Architecture",
							collapsed: true,
							items: [
								{ label: "Overview", slug: "architecture" },
								{ label: "Packages and data flow", slug: "architecture/packages-data-flow" },
								{ label: "Pipeline and storage", slug: "architecture/pipeline-storage" },
								{ label: "Platform services", slug: "architecture/platform-services" },
								{ label: "Data lifecycle", slug: "architecture/data-lifecycle" },
								{ label: "Interfaces and agents", slug: "architecture/interfaces-agents" },
							],
						},
						{ label: "Contributing", slug: "contributing" },
						{ label: "Your first PR", slug: "first-pr" },
						{ label: "Benchmarks", slug: "benchmarking" },
						{ label: "Roadmap", slug: "roadmap" },
					],
				},
			],
		}),
	],
});

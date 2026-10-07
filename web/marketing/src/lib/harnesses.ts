export interface Harness {
	readonly name: string;
	readonly kind: string;
	readonly logo: string;
	readonly href: string;
	readonly analytics: string;
	readonly invert?: boolean;
}

export const HARNESSES: readonly Harness[] = [
	{
		name: "Claude Code",
		kind: "session hooks",
		logo: "/dashboard/logos/claude.svg",
		href: "https://docs.anthropic.com/en/docs/claude-code",
		analytics: "claude_code",
	},
	{
		name: "OpenCode",
		kind: "runtime plugin",
		logo: "/dashboard/logos/opencode.svg",
		href: "https://github.com/sst/opencode",
		analytics: "opencode",
	},
	{
		name: "OpenClaw",
		kind: "runtime adapter",
		logo: "/dashboard/logos/openclaw.svg",
		href: "https://github.com/openclaw/openclaw",
		analytics: "openclaw",
	},
	{
		name: "Codex",
		kind: "hooks + MCP",
		logo: "/dashboard/logos/openai.svg",
		href: "https://github.com/openai/codex",
		analytics: "codex",
	},
	{
		name: "Hermes Agent",
		kind: "memory provider",
		logo: "/dashboard/logos/hermes-agent.svg",
		href: "https://github.com/NousResearch/hermes-agent",
		analytics: "hermes_agent",
		invert: true,
	},
	{
		name: "Gemini CLI",
		kind: "MCP + GEMINI.md",
		logo: "/dashboard/logos/gemini.svg",
		href: "https://github.com/google-gemini/gemini-cli",
		analytics: "gemini_cli",
	},
	{
		name: "Pi",
		kind: "connector",
		logo: "/dashboard/logos/pi.svg",
		href: "https://github.com/Signet-AI/signetai/tree/main/integrations/pi/connector",
		analytics: "pi",
	},
	{
		name: "Oh My Pi",
		kind: "runtime extension",
		logo: "/dashboard/logos/oh-my-pi.svg",
		href: "https://github.com/Signet-AI/signetai/tree/main/integrations/oh-my-pi/connector",
		analytics: "oh_my_pi",
		invert: true,
	},
	{
		name: "ForgeCode",
		kind: "MCP + skills",
		logo: "/dashboard/logos/forge.svg",
		href: "https://forgecode.dev",
		analytics: "forge",
	},
	{
		name: "Kimi CLI",
		kind: "hooks + MCP",
		logo: "/dashboard/logos/kimi.png",
		href: "https://github.com/MoonshotAI/kimi-cli",
		analytics: "kimi",
	},
	{
		name: "Muse Code",
		kind: "hooks + MCP",
		logo: "/dashboard/logos/muse-code.png",
		href: "https://dev.meta.ai/docs/muse-code",
		analytics: "muse_code",
	},
];

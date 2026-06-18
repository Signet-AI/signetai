export type IdentityPresetName = "minimal" | "hermes" | "openclaw" | "custom";

export type IdentityFileContext = "startup" | "session";

export type IdentitySessionKind = "dreaming" | "heartbeat" | "bootstrap";

export interface IdentityFileSpec {
	/** Relative path from the base directory */
	path: string;
	/** Human-readable description */
	description: string;
	/** Whether this file is optional */
	optional?: boolean;
	/** Whether this file is loaded during normal startup or only in a special session */
	context?: IdentityFileContext;
	/** Special session kind when context is "session" */
	session?: IdentitySessionKind;
}

export interface IdentityContextFileEntry {
	path: string;
	role?: string;
	budget?: number;
	enabled?: boolean;
}

export interface IdentitySpecialFileEntry extends IdentityContextFileEntry {
	kind: IdentitySessionKind;
}

export interface IdentityPresetSpec {
	name: IdentityPresetName;
	description: string;
	startup: IdentityContextFileEntry[];
	special: IdentitySpecialFileEntry[];
}

/**
 * Standard identity files that form the cross-harness identity standard.
 * These are recognized by Signet and multiple harnesses.
 */
export const IDENTITY_FILES: Record<string, IdentityFileSpec> = {
	agents: {
		path: "AGENTS.md",
		description: "Operational rules and behavioral settings",
		optional: false,
	},
	soul: {
		path: "SOUL.md",
		description: "Persona, character, and security settings",
		optional: false,
	},
	identity: {
		path: "IDENTITY.md",
		description: "Agent name, creature type, and vibe",
		optional: false,
	},
	user: {
		path: "USER.md",
		description: "User profile and preferences",
		optional: false,
	},
	heartbeat: {
		path: "HEARTBEAT.md",
		description: "Heartbeat prompt used only for heartbeat/background check sessions",
		optional: true,
		context: "session",
		session: "heartbeat",
	},
	memory: {
		path: "MEMORY.md",
		description: "Memory index and summary",
		optional: true,
	},
	tools: {
		path: "TOOLS.md",
		description: "Tool preferences and notes",
		optional: true,
	},
	bootstrap: {
		path: "BOOTSTRAP.md",
		description: "Setup ritual (typically deleted after first run)",
		optional: true,
		context: "session",
		session: "bootstrap",
	},
	dreaming: {
		path: "DREAMING.md",
		description: "Dreaming/reflection prompt used only for dreaming sessions",
		optional: true,
		context: "session",
		session: "dreaming",
	},
};

export const IDENTITY_PRESETS: Record<IdentityPresetName, IdentityPresetSpec> = {
	minimal: {
		name: "minimal",
		description: "AGENTS.md only for normal startup, plus DREAMING.md for dreaming sessions.",
		startup: [{ path: "AGENTS.md", role: "operating_instructions", budget: 12_000 }],
		special: [{ path: "DREAMING.md", kind: "dreaming", role: "dreaming_prompt", budget: 4_000 }],
	},
	hermes: {
		name: "hermes",
		description: "Hermes-style SOUL.md primary identity with project-context discovery handled by Hermes.",
		startup: [
			{ path: "SOUL.md", role: "primary_identity", budget: 4_000 },
			{ path: "AGENTS.md", role: "project_context", budget: 12_000 },
		],
		special: [{ path: "DREAMING.md", kind: "dreaming", role: "dreaming_prompt", budget: 4_000 }],
	},
	openclaw: {
		name: "openclaw",
		description: "OpenClaw-style rich identity stack for character-forward agents.",
		startup: [
			{ path: "AGENTS.md", role: "operating_instructions", budget: 12_000 },
			{ path: "SOUL.md", role: "persona", budget: 4_000 },
			{ path: "IDENTITY.md", role: "agent_identity", budget: 2_000 },
			{ path: "USER.md", role: "user_profile", budget: 6_000 },
			{ path: "MEMORY.md", role: "working_memory", budget: 10_000 },
		],
		special: [
			{ path: "HEARTBEAT.md", kind: "heartbeat", role: "heartbeat_prompt", budget: 4_000 },
			{ path: "DREAMING.md", kind: "dreaming", role: "dreaming_prompt", budget: 4_000 },
			{ path: "BOOTSTRAP.md", kind: "bootstrap", role: "bootstrap_prompt", budget: 4_000 },
		],
	},
	custom: {
		name: "custom",
		description: "User-selected startup files and explicit order.",
		startup: [{ path: "AGENTS.md", role: "operating_instructions", budget: 12_000 }],
		special: [{ path: "DREAMING.md", kind: "dreaming", role: "dreaming_prompt", budget: 4_000 }],
	},
};

/**
 * Required identity files (non-optional)
 */
export const REQUIRED_IDENTITY_KEYS = Object.entries(IDENTITY_FILES)
	.filter(([, spec]) => !spec.optional)
	.map(([key]) => key);

/**
 * Optional identity files
 */
export const OPTIONAL_IDENTITY_KEYS = Object.entries(IDENTITY_FILES)
	.filter(([, spec]) => spec.optional)
	.map(([key]) => key);

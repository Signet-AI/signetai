/**
 * Main Signet class - entry point for the library
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DEFAULT_BASE_PATH } from "./constants";
import { Database } from "./database";
import { generateManifest, parseManifest } from "./manifest";
import { generateMemory, parseMemory } from "./memory";
import { generateSoul, parseSoul } from "./soul";
import type { Agent, AgentConfig, AgentManifest } from "./types";

export class Signet {
	private config: AgentConfig;
	private db: Database | null = null;
	private agent: Agent | null = null;

	constructor(config: AgentConfig = {}) {
		this.config = {
			basePath: config.basePath || DEFAULT_BASE_PATH,
			autoSync: config.autoSync ?? true,
			...config,
		};
	}

	/**
	 * Initialize Signet in a directory
	 */
	async init(name: string): Promise<Agent> {
		const basePath = this.config.basePath!;

		if (!existsSync(basePath)) {
			mkdirSync(basePath, { recursive: true });
		}

		const manifest: AgentManifest = {
			version: 1,
			schema: "signet/v1",
			agent: {
				name,
				created: new Date().toISOString(),
				updated: new Date().toISOString(),
			},
			trust: {
				verification: "none",
			},
		};

		// Write files
		writeFileSync(join(basePath, "agent.yaml"), generateManifest(manifest));
		writeFileSync(join(basePath, "soul.md"), generateSoul(name));
		writeFileSync(join(basePath, "memory.md"), generateMemory());

		// Initialize database
		this.db = new Database(join(basePath, "agent.db"));
		await this.db.init();

		this.agent = {
			manifest,
			soul: readFileSync(join(basePath, "soul.md"), "utf-8"),
			memory: readFileSync(join(basePath, "memory.md"), "utf-8"),
			dbPath: join(basePath, "agent.db"),
		};

		return this.agent;
	}

	/**
	 * Load an existing Signet agent
	 */
	async load(): Promise<Agent> {
		const basePath = this.config.basePath!;

		if (!existsSync(join(basePath, "agent.yaml"))) {
			throw new Error(`No agent found at ${basePath}. Run 'signet init' first.`);
		}

		const manifestYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		const manifest = parseManifest(manifestYaml);

		this.db = new Database(join(basePath, "agent.db"));
		await this.db.init();

		this.agent = {
			manifest,
			soul: readFileSync(join(basePath, "soul.md"), "utf-8"),
			memory: readFileSync(join(basePath, "memory.md"), "utf-8"),
			dbPath: join(basePath, "agent.db"),
		};

		return this.agent;
	}

	/**
	 * Get the current agent
	 */
	getAgent(): Agent | null {
		return this.agent;
	}

	/**
	 * Get the database instance
	 */
	getDatabase(): Database | null {
		return this.db;
	}

	/**
	 * Detect if Signet is installed
	 */
	static detect(basePath?: string): boolean {
		const path = basePath || DEFAULT_BASE_PATH;
		return existsSync(join(path, "agent.yaml"));
	}

	/**
	 * Get the default base path
	 */
	static getDefaultPath(): string {
		return DEFAULT_BASE_PATH;
	}
}

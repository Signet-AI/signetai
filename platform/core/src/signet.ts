import { Database } from "./database";
import { Agent, AgentConfig, AgentManifest } from "./types";
import { parseManifest, generateManifest } from "./manifest";
import { parseSoul, generateSoul } from "./soul";
import { parseMemory, generateMemory } from "./memory";
import { resolveDefaultBasePath } from "./constants";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export class Signet {
	private config: AgentConfig;
	private db: Database | null = null;
	private agent: Agent | null = null;

	constructor(config: AgentConfig = {}) {
		this.config = {
			basePath: config.basePath || resolveDefaultBasePath(),
			autoSync: config.autoSync ?? true,
			...config,
		};
	}
	async init(name: string): Promise<Agent> {
		const basePath = this.getBasePath();

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
		writeFileSync(join(basePath, "agent.yaml"), generateManifest(manifest));
		writeFileSync(join(basePath, "soul.md"), generateSoul(name));
		writeFileSync(join(basePath, "memory.md"), generateMemory());
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
	async load(): Promise<Agent> {
		const basePath = this.getBasePath();

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
	getAgent(): Agent | null {
		return this.agent;
	}
	getDatabase(): Database | null {
		return this.db;
	}

	private getBasePath(): string {
		const { basePath } = this.config;
		if (!basePath) throw new Error("Signet base path is not configured");
		return basePath;
	}
	static detect(basePath?: string): boolean {
		const path = basePath || resolveDefaultBasePath();
		return existsSync(join(path, "agent.yaml"));
	}
	static getDefaultPath(): string {
		return resolveDefaultBasePath();
	}
}

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { MEMORY_HEAD_MAX_TOKENS, writeMemoryHead } from "./memory-head";

const tok = new Tiktoken(cl100k_base);

let agentsDir = "";
let prevSignetPath: string | undefined;

function readMemoryHead(): string {
	return readFileSync(join(agentsDir, "MEMORY.md"), "utf-8");
}

function readAgentMemoryHead(agentId: string): string {
	return readFileSync(join(agentsDir, "agents", agentId, "MEMORY.md"), "utf-8");
}

describe("writeMemoryHead", () => {
	beforeAll(() => {
		prevSignetPath = process.env.SIGNET_PATH;
		agentsDir = mkdtempSync(join(tmpdir(), "signet-memory-head-"));
		process.env.SIGNET_PATH = agentsDir;
	});

	beforeEach(() => {
		closeDbAccessor();
		rmSync(agentsDir, { recursive: true, force: true });
		mkdirSync(agentsDir, { recursive: true });
	});

	afterEach(() => {
		closeDbAccessor();
	});

	afterAll(() => {
		rmSync(agentsDir, { recursive: true, force: true });
		if (prevSignetPath === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
			return;
		}
		process.env.SIGNET_PATH = prevSignetPath;
	});

	it("keeps short MEMORY.md content intact", () => {
		const content = "# MEMORY\n\n## Active\n- short note\n";

		const result = writeMemoryHead(content);
		expect(result.ok).toBe(true);

		const file = readMemoryHead();
		expect(file.startsWith("<!-- generated ")).toBe(true);
		expect(file).toContain("## Active\n- short note");
		expect(tok.encode(file).length).toBeLessThanOrEqual(MEMORY_HEAD_MAX_TOKENS);
	});

	it("stores memory head state under the requested agent scope", () => {
		initDbAccessor(join(agentsDir, "memory", "memories.db"), { agentsDir });

		const result = writeMemoryHead("# MEMORY\n\n## Active\n- agent-specific synthesis\n", {
			agentId: "agent-a",
			owner: "memory-head-test",
		});
		expect(result.ok).toBe(true);

		const row = getDbAccessor().withReadDb((db) => {
			return db.prepare("SELECT agent_id, content, revision FROM memory_md_heads WHERE agent_id = ?").get("agent-a") as
				| { agent_id: string; content: string; revision: number }
				| undefined;
		});
		expect(row).toEqual({
			agent_id: "agent-a",
			content: "# MEMORY\n\n## Active\n- agent-specific synthesis",
			revision: 1,
		});

		const otherCount = getDbAccessor().withReadDb((db) => {
			const result = db.prepare("SELECT COUNT(*) as n FROM memory_md_heads WHERE agent_id = 'default'").get() as {
				n: number;
			};
			return result.n;
		});
		expect(otherCount).toBe(0);
	});

	it("writes named-agent projections to the agent-local MEMORY.md", () => {
		initDbAccessor(join(agentsDir, "memory", "memories.db"), { agentsDir });

		const result = writeMemoryHead("# MEMORY\n\n## Active\n- local to agent-a\n", {
			agentId: "agent-a",
			owner: "memory-head-test",
		});
		expect(result.ok).toBe(true);

		const file = readAgentMemoryHead("agent-a");
		expect(file.startsWith("<!-- generated ")).toBe(true);
		expect(file).toContain("local to agent-a");
		expect(existsSync(join(agentsDir, "MEMORY.md"))).toBe(false);
	});

	it("rejects unsafe agent ids before writing a projection", () => {
		initDbAccessor(join(agentsDir, "memory", "memories.db"), { agentsDir });

		const result = writeMemoryHead("# MEMORY\n\n## Active\n- should not write\n", {
			agentId: "../agent-a",
			owner: "memory-head-test",
		});
		expect(result).toEqual({
			ok: false,
			error: "Invalid agentId for MEMORY.md path: ../agent-a",
			code: "invalid",
		});
		expect(existsSync(join(agentsDir, "MEMORY.md"))).toBe(false);
		expect(existsSync(join(agentsDir, "agents"))).toBe(false);
	});

	it("truncates the tail of oversized MEMORY.md content to 5000 tokens", () => {
		const keep = "# MEMORY\n\n## Active\n- retain this context\n\n";
		const chunk =
			"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega\n";
		const tail = "\n## Tail Marker\nthis section should be truncated away\n";
		let content = keep;

		while (tok.encode(content).length < 6000) {
			content += chunk;
		}
		content += tail;

		const result = writeMemoryHead(content);
		expect(result.ok).toBe(true);

		const file = readMemoryHead();
		expect(file.startsWith("<!-- generated ")).toBe(true);
		expect(file).toContain("retain this context");
		expect(file).not.toContain("## Tail Marker");
		expect(tok.encode(file).length).toBeLessThanOrEqual(MEMORY_HEAD_MAX_TOKENS);
	});
});

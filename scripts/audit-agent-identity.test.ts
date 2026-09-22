import { describe, expect, test } from "bun:test";
import { auditAgentIdentity, isAgentIdentitySource, type AgentIdentitySource } from "./audit-agent-identity";

function source(path: string, content: string): AgentIdentitySource {
	return { content, path };
}

describe("agent identity source scope", () => {
	test("includes runtime TypeScript and Python while excluding tests and generated distributions", () => {
		expect(isAgentIdentitySource("integrations/hermes-agent/connector/src/index.ts")).toBe(true);
		expect(isAgentIdentitySource("integrations/hermes-agent/source/signet_source.py")).toBe(true);
		expect(isAgentIdentitySource("integrations/hermes-agent/connector/src/index.test.ts")).toBe(false);
		expect(isAgentIdentitySource("dist/signetai/hermes-plugin/__init__.py")).toBe(false);
		expect(isAgentIdentitySource("scripts/migrate.ts")).toBe(false);
	});
});

describe("agent identity audit", () => {
	test("rejects TypeScript harness literals used as implicit agent fallbacks", () => {
		const violations = auditAgentIdentity([
			source("integrations/example/src/index.ts", 'const resolved = agentId ?? "hermes-agent";'),
			source("integrations/example/src/typed.ts", 'const resolved = agentId ?? ("hermes-agent" as string);'),
			source("libs/example/src/index.ts", 'const resolved = request.agent_id || "hermes-agent";'),
			source("platform/daemon/src/identity.ts", 'const resolved = agentId ? agentId : "hermes-agent";'),
			source("platform/daemon/src/nested.ts", 'const resolved = config ?? (configured ? runtimeId : "hermes-agent");'),
			source("platform/daemon/src/reversed.ts", 'const agentId = configured ? "hermes-agent" : runtimeId;'),
		]);
		expect(violations.map(({ path, line }) => `${path}:${line}`)).toEqual([
			"integrations/example/src/index.ts:1",
			"integrations/example/src/typed.ts:1",
			"libs/example/src/index.ts:1",
			"platform/daemon/src/identity.ts:1",
			"platform/daemon/src/nested.ts:1",
			"platform/daemon/src/reversed.ts:1",
		]);
	});

	test("rejects Python environment fallbacks to a harness identity", () => {
		const violations = auditAgentIdentity([
			source(
				"integrations/example/source/plugin.py",
				[
					'agent_id = os.environ["SIGNET_AGENT_ID"] or "hermes-agent"',
					"value = os.environ.get(",
					'    "SIGNET_AGENT_ID",',
					'    "hermes-agent"',
					")",
					'fallback = os.getenv("SIGNET_AGENT_ID") or "hermes-agent"',
					'agent_id = configured if configured else "hermes-agent"',
					"agent_id = (",
					'    os.environ.get("SIGNET_AGENT_ID")',
					'    or "hermes-agent"',
					")",
				].join("\n"),
			),
		]);
		expect(violations.map(({ line }) => line)).toEqual([1, 4, 6, 7, 10]);
	});

	test("accepts harness provenance, explicit comparisons, and the canonical default", () => {
		const violations = auditAgentIdentity([
			source(
				"integrations/hermes-agent/connector/src/index.ts",
				[
					'const harnessId = "hermes-agent";',
					'const stale = agentId === "hermes-agent";',
					'const resolved = agentId ?? "default";',
					'const selectedHarness = configured ? "hermes-agent" : "other";',
				].join("\n"),
			),
			source(
				"integrations/hermes-agent/source/signet_source.py",
				[
					'agent_id = os.environ.get("SIGNET_AGENT_ID", "").strip() or "default"',
					'harness: str = "hermes-agent"',
					'client = SignetClient(harness="hermes-agent")',
					'who = "hermes-agent"',
					'legacy = agent_id == "hermes-agent"',
					'logger.warning("SIGNET_AGENT_ID=\u0027hermes-agent\u0027 is stale")',
				].join("\n"),
			),
		]);
		expect(violations).toEqual([]);
	});

	test("sorts findings deterministically", () => {
		const violations = auditAgentIdentity([
			source("z.ts", 'const value = agentId ?? "hermes-agent";'),
			source("a.py", 'value = os.environ.get("SIGNET_AGENT_ID", "hermes-agent")'),
		]);
		expect(violations.map(({ path }) => path)).toEqual(["a.py", "z.ts"]);
	});
});

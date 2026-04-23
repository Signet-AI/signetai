import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendProviderTransitions,
	detectProviderTransitions,
	executeProviderRollback,
	isRemotePipelineProvider,
	parseProviderSafetyRole,
	preserveLockInYaml,
	readProviderSafetySnapshot,
	readProviderTransitions,
	resolveRollbackFilePath,
	tryReadProviderSafetySnapshot,
	validateProviderSafety,
} from "../provider-safety";

let agentsDir: string | undefined;

afterEach(() => {
	if (agentsDir) {
		rmSync(agentsDir, { recursive: true, force: true });
		agentsDir = undefined;
	}
});

function makeAgentsDir(): string {
	agentsDir = mkdtempSync(join(tmpdir(), "signet-provider-safety-route-"));
	return agentsDir;
}

function yamlWithExtraction(provider: string, allowRemote = true): string {
	return [
		"memory:",
		"  pipelineV2:",
		`    allowRemoteProviders: ${allowRemote}`,
		"    extraction:",
		`      provider: ${provider}`,
		"",
	].join("\n");
}

describe("provider safety guard - config save validation", () => {
	it("validateProviderSafety rejects remote provider when allowRemoteProviders is false", () => {
		const yaml = yamlWithExtraction("anthropic", false);
		const result = validateProviderSafety(yaml);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("allowRemoteProviders is false");
			expect(result.error).toContain("anthropic");
		}
	});

	it("validateProviderSafety accepts local provider when allowRemoteProviders is false", () => {
		const yaml = yamlWithExtraction("ollama", false);
		const result = validateProviderSafety(yaml);
		expect(result.ok).toBe(true);
	});

	it("validateProviderSafety accepts remote provider when allowRemoteProviders is true", () => {
		const yaml = yamlWithExtraction("anthropic", true);
		const result = validateProviderSafety(yaml);
		expect(result.ok).toBe(true);
	});

	it("detectProviderTransitions records local-to-remote transitions as risky", () => {
		const before = yamlWithExtraction("ollama", true);
		const after = yamlWithExtraction("anthropic", true);
		const transitions = detectProviderTransitions(before, after, "agent.yaml");
		expect(transitions.length).toBe(1);
		expect(transitions[0].from).toBe("ollama");
		expect(transitions[0].to).toBe("anthropic");
		expect(transitions[0].risky).toBe(true);
	});

	it("detectProviderTransitions records remote-to-local as not risky", () => {
		const before = yamlWithExtraction("anthropic", true);
		const after = yamlWithExtraction("ollama", true);
		const transitions = detectProviderTransitions(before, after, "agent.yaml");
		expect(transitions.length).toBe(1);
		expect(transitions[0].risky).toBe(false);
	});
});

describe("provider safety guard - rollback path", () => {
	it("rejects invalid rollback role values instead of widening scope", () => {
		expect(parseProviderSafetyRole("extracton")).toEqual({
			ok: false,
			error: "role must be 'extraction' or 'synthesis'",
		});
		expect(parseProviderSafetyRole("extraction")).toEqual({ ok: true, role: "extraction" });
		expect(parseProviderSafetyRole(undefined)).toEqual({ ok: true });
	});

	it("resolveRollbackFilePath returns transitions to avoid double-read", async () => {
		const dir = makeAgentsDir();
		mkdirSync(dir, { recursive: true });
		const agentYaml = join(dir, "agent.yaml");
		writeFileSync(agentYaml, yamlWithExtraction("anthropic", true));

		await appendProviderTransitions(
			dir,
			detectProviderTransitions(
				yamlWithExtraction("ollama", true),
				yamlWithExtraction("anthropic", true),
				"agent.yaml",
			),
		);

		const { filePath, transitions } = resolveRollbackFilePath(dir);
		expect(filePath).toBe(agentYaml);
		expect(transitions.length).toBe(1);

		const result = await executeProviderRollback(dir, filePath, undefined, undefined, transitions);
		expect(result.success).toBe(true);
		expect(result.rolledBack.from).toBe("ollama");
		expect(result.rolledBack.to).toBe("anthropic");
		expect(result.providerTransitions.length).toBeGreaterThanOrEqual(1);
	});

	it("executeProviderRollback still works without priorTransitions (backward compat)", async () => {
		const dir = makeAgentsDir();
		mkdirSync(dir, { recursive: true });
		const agentYaml = join(dir, "agent.yaml");
		writeFileSync(agentYaml, yamlWithExtraction("anthropic", true));

		await appendProviderTransitions(
			dir,
			detectProviderTransitions(
				yamlWithExtraction("ollama", true),
				yamlWithExtraction("anthropic", true),
				"agent.yaml",
			),
		);

		const { filePath } = resolveRollbackFilePath(dir);
		const result = await executeProviderRollback(dir, filePath);
		expect(result.success).toBe(true);
	});
});

describe("provider safety guard - audit write resilience", () => {
	it("transitions persist and are readable after append", async () => {
		const dir = makeAgentsDir();
		mkdirSync(dir, { recursive: true });

		const before = yamlWithExtraction("ollama", true);
		const after = yamlWithExtraction("anthropic", true);
		const entries = detectProviderTransitions(before, after, "agent.yaml");
		await appendProviderTransitions(dir, entries);

		const read = readProviderTransitions(dir);
		expect(read.length).toBe(1);
		expect(read[0].to).toBe("anthropic");
		expect(read[0].risky).toBe(true);
	});
});

describe("provider safety guard - route serialization integration", () => {
	it("GET snapshot strips allowRemoteProvidersExplicit", () => {
		const yaml = yamlWithExtraction("anthropic", true);
		const snapshot = readProviderSafetySnapshot(yaml);
		const { allowRemoteProvidersExplicit: _, ...publicSnapshot } = snapshot;
		expect(publicSnapshot.allowRemoteProviders).toBe(true);
		expect((publicSnapshot as Record<string, unknown>).allowRemoteProvidersExplicit).toBeUndefined();
	});

	it("POST lock-bypass check: explicit vs implicit allowRemoteProviders", () => {
		const prior = yamlWithExtraction("ollama", false);
		const incomingOmitted = ["memory:", "  pipelineV2:", "    extraction:", "      provider: anthropic", ""].join("\n");
		const incomingExplicit = [
			"memory:",
			"  pipelineV2:",
			"    allowRemoteProviders: true",
			"    extraction:",
			"      provider: anthropic",
			"",
		].join("\n");
		const priorSnap = tryReadProviderSafetySnapshot(prior);
		expect(priorSnap).not.toBeNull();
		expect(priorSnap?.allowRemoteProviders).toBe(false);
		const incomingOmittedSnap = tryReadProviderSafetySnapshot(incomingOmitted);
		const incomingExplicitSnap = tryReadProviderSafetySnapshot(incomingExplicit);
		expect(incomingOmittedSnap).not.toBeNull();
		expect(incomingExplicitSnap).not.toBeNull();
		const lockImplicitlyLiftedOmitted =
			incomingOmittedSnap &&
			!incomingOmittedSnap.allowRemoteProvidersExplicit &&
			incomingOmittedSnap.allowRemoteProviders;
		const lockImplicitlyLiftedExplicit =
			incomingExplicitSnap &&
			!incomingExplicitSnap.allowRemoteProvidersExplicit &&
			incomingExplicitSnap.allowRemoteProviders;
		expect(lockImplicitlyLiftedOmitted).toBe(true);
		expect(lockImplicitlyLiftedExplicit).toBe(false);
		expect(incomingExplicitSnap?.allowRemoteProvidersExplicit).toBe(true);
		expect(isRemotePipelineProvider(incomingOmittedSnap?.extractionProvider)).toBe(true);
	});
});

describe("provider safety guard - lock preservation on config save", () => {
	it("re-injects allowRemoteProviders: false when incoming omits it and prior has lock", () => {
		const priorYaml = yamlWithExtraction("ollama", false);
		const incomingYaml = [
			"memory:",
			"  pipelineV2:",
			"    extraction:",
			"      provider: ollama",
			"    extractionTimeout: 30000",
			"",
		].join("\n");
		const prior = tryReadProviderSafetySnapshot(priorYaml);
		const incoming = tryReadProviderSafetySnapshot(incomingYaml);
		expect(prior?.allowRemoteProviders).toBe(false);
		if (!incoming) throw new Error("expected incoming provider safety snapshot");
		expect(incoming.allowRemoteProviders).toBe(true);
		expect(incoming.allowRemoteProvidersExplicit).toBe(false);
		const lockImplicitlyLifted = incoming && !incoming.allowRemoteProvidersExplicit && incoming.allowRemoteProviders;
		expect(lockImplicitlyLifted).toBe(true);
		const blocked = [
			["extraction", incoming.extractionProvider],
			["synthesis", incoming.synthesisProvider],
		].filter(([, p]) => isRemotePipelineProvider(p));
		expect(blocked.length).toBe(0);
		const preserved = preserveLockInYaml(incomingYaml);
		const snap = readProviderSafetySnapshot(preserved);
		expect(snap.allowRemoteProviders).toBe(false);
		expect(snap.allowRemoteProvidersExplicit).toBe(true);
	});

	it("preserves the lock when called (unconditional within its narrow scope)", () => {
		const incomingYaml = yamlWithExtraction("anthropic", true);
		const preserved = preserveLockInYaml(incomingYaml);
		const snap = readProviderSafetySnapshot(preserved);
		expect(snap.allowRemoteProviders).toBe(false);
		expect(snap.allowRemoteProvidersExplicit).toBe(true);
	});

	it("does not re-inject when lock is already present", () => {
		const incomingYaml = yamlWithExtraction("ollama", false);
		const preserved = preserveLockInYaml(incomingYaml);
		const snap = readProviderSafetySnapshot(preserved);
		expect(snap.allowRemoteProviders).toBe(false);
	});

	it("does not create pipelineV2 section when incoming config has none", () => {
		const incomingYaml = "name: test\nversion: 1\n";
		const preserved = preserveLockInYaml(incomingYaml);
		expect(preserved).toBe(incomingYaml);
		expect(preserved).not.toContain("pipelineV2");
		expect(preserved).not.toContain("allowRemoteProviders");
	});

	it("does not create memory section when incoming config has none", () => {
		const incomingYaml = "name: test\n";
		const preserved = preserveLockInYaml(incomingYaml);
		expect(preserved).toBe(incomingYaml);
	});
});

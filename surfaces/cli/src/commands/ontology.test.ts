import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerOntologyCommands } from "./ontology";

const prevLog = console.log;
const prevError = console.error;

afterEach(() => {
	console.log = prevLog;
	console.error = prevError;
});

describe("registerOntologyCommands", () => {
	test("objects lists ontology objects through knowledge navigation", async () => {
		const calls: Array<{ readonly method: string; readonly path: string }> = [];
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (method, path) => {
				calls.push({ method, path });
				return {
					ok: true,
					data: {
						items: [
							{
								entity: { id: "entity-1", name: "Signet", entityType: "project" },
								aspectCount: 2,
								attributeCount: 3,
								constraintCount: 1,
								dependencyCount: 4,
							},
						],
					},
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"objects",
			"--query",
			"Signet",
			"--type",
			"project",
			"--limit",
			"5",
			"--agent",
			"ant",
		]);

		expect(calls).toEqual([
			{
				method: "GET",
				path: "/api/knowledge/navigation/entities?q=Signet&type=project&limit=5&agent_id=ant",
			},
		]);
		expect(lines.join("\n")).toContain("Ontology Objects");
		expect(lines.join("\n")).toContain("Signet");
	});

	test("object and links aliases call existing knowledge endpoints", async () => {
		const calls: Array<{ readonly method: string; readonly path: string }> = [];
		console.log = () => {};

		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (method, path) => {
				calls.push({ method, path });
				return { ok: true, data: { items: [] } };
			},
		});

		await program.parseAsync(["node", "test", "ontology", "object", "Signet", "--name", "--agent", "ant"]);
		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"links",
			"entity-1",
			"--direction",
			"outgoing",
			"--agent",
			"ant",
		]);

		expect(calls).toEqual([
			{ method: "GET", path: "/api/knowledge/navigation/entity?agent_id=ant&name=Signet" },
			{ method: "GET", path: "/api/knowledge/entities/entity-1/dependencies?direction=outgoing&agent_id=ant" },
		]);
	});

	test("claims alias calls the claim-slot navigation endpoint", async () => {
		let capturedPath = "";
		console.log = () => {};

		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, path) => {
				capturedPath = path;
				return { ok: true, data: { items: [{ claimKey: "proposal_loop", activeCount: 1 }] } };
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"claims",
			"Signet",
			"architecture",
			"ontology",
			"--agent",
			"ant",
		]);

		expect(capturedPath).toBe(
			"/api/knowledge/navigation/claims?entity=Signet&aspect=architecture&group=ontology&agent_id=ant",
		);
	});

	test("repair duplicates posts a dry-run request by default", async () => {
		const calls: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (method, path, body) => {
				calls.push({ method, path, body });
				return {
					ok: true,
					data: {
						dryRun: true,
						writtenCount: 0,
						items: [
							{
								canonicalName: "signet",
								target: { name: "Signet" },
								sources: [{ name: "SIGNET" }],
								rationale: 'Entities share canonical_name "signet" in the same agent scope.',
							},
						],
					},
				};
			},
		});

		await program.parseAsync(["node", "test", "ontology", "repair", "--duplicates", "--agent", "ant", "--limit", "5"]);

		expect(calls).toEqual([
			{
				method: "POST",
				path: "/api/ontology/proposals/repair/duplicates",
				body: {
					agent_id: "ant",
					created_by: "ontology-repair",
					limit: 5,
					write_proposals: false,
				},
			},
		]);
		expect(lines.join("\n")).toContain("Duplicate Merge Candidates");
		expect(lines.join("\n")).toContain("Signet <- SIGNET");
	});

	test("import-proposals maps extraction output to batch proposal creation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-ontology-cli-"));
		const file = join(dir, "extraction.json");
		writeFileSync(
			file,
			JSON.stringify({
				claim_values: [
					{
						entity: "Signet",
						aspect: "architecture",
						group_key: "ontology",
						claim_key: "proposal_loop",
						value: "Extraction emits pending proposals.",
						confidence: 0.9,
						evidence: [{ transcript_id: "transcript:1" }],
					},
				],
				links: [
					{
						source_entity: "Transcript",
						link_type: "supports_claim",
						target_entity: "Signet",
						reason: "Transcript supports the claim.",
					},
				],
			}),
		);
		const calls: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];
		console.log = () => {};

		try {
			const program = new Command();
			registerOntologyCommands(program, {
				ensureDaemonForSecrets: async () => true,
				secretApiCall: async (method, path, body) => {
					calls.push({ method, path, body });
					return { ok: true, data: { count: 2 } };
				},
			});

			await program.parseAsync([
				"node",
				"test",
				"ontology",
				"import-proposals",
				"--file",
				file,
				"--agent",
				"ant",
				"--created-by",
				"extractor",
				"--source-kind",
				"transcript",
				"--source-id",
				"transcript:1",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}

		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.path).toBe("/api/ontology/proposals/batch");
		const body = calls[0]?.body as {
			readonly agent_id?: string;
			readonly created_by?: string;
			readonly proposals?: readonly { readonly operation?: string; readonly payload?: Record<string, unknown> }[];
		};
		expect(body.agent_id).toBe("ant");
		expect(body.created_by).toBe("extractor");
		expect(body.proposals?.map((proposal) => proposal.operation)).toEqual(["add_claim_value", "create_link"]);
		expect(body.proposals?.[0]?.payload?.claim_key).toBe("proposal_loop");
		expect(body.proposals?.[1]?.payload?.link_type).toBe("supports_claim");
	});
});

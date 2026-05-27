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
	test("registers the public audited mutation command tree", () => {
		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async () => ({ ok: true, data: {} }),
		});

		const ontology = program.commands.find((cmd) => cmd.name() === "ontology");
		expect(ontology).toBeDefined();
		if (!ontology) throw new Error("ontology command was not registered");
		expect(ontology?.commands.map((cmd) => cmd.name())).toEqual(
			expect.arrayContaining(["entity", "claim", "aspect", "link", "stream", "assertions", "assertion"]),
		);

		const names = (parent: Command, name: string): readonly string[] =>
			parent.commands.find((cmd) => cmd.name() === name)?.commands.map((cmd) => cmd.name()) ?? [];
		expect(names(ontology, "entity")).toEqual(
			expect.arrayContaining(["create", "rename", "merge", "merge-plan", "archive", "alias"]),
		);
		expect(names(ontology, "claim")).toEqual(expect.arrayContaining(["set", "versions", "show", "archive", "restore"]));
		expect(names(ontology, "aspect")).toEqual(expect.arrayContaining(["create", "rename", "archive"]));
		expect(names(ontology, "link")).toEqual(expect.arrayContaining(["create", "update", "archive"]));
		expect(names(ontology, "stream")).toEqual(expect.arrayContaining(["apply"]));
		expect(names(ontology, "assertion")).toEqual(
			expect.arrayContaining(["show", "create", "link-claim", "archive", "supersede", "import"]),
		);
	});

	test("entity alias commands call ontology alias endpoints", async () => {
		const calls: Array<{ readonly method: string; readonly path: string; readonly body?: unknown }> = [];
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
						item: { id: "alias-1", alias: "SignetAI", status: "active", confidence: 0.9 },
						items: [{ id: "alias-1", alias: "SignetAI", status: "active", confidence: 0.9 }],
					},
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"entity",
			"alias",
			"list",
			"entity-signet",
			"--status",
			"all",
			"--agent",
			"ant",
		]);
		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"entity",
			"alias",
			"add",
			"entity-signet",
			"SignetAI",
			"--confidence",
			"0.9",
			"--source",
			"operator",
			"--agent",
			"ant",
		]);
		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"entity",
			"alias",
			"archive",
			"entity-signet",
			"alias-1",
			"--agent",
			"ant",
		]);

		expect(calls).toEqual([
			{
				method: "GET",
				path: "/api/ontology/entities/entity-signet/aliases?agent_id=ant&status=all",
				body: undefined,
			},
			{
				method: "POST",
				path: "/api/ontology/entities/entity-signet/aliases?agent_id=ant",
				body: { alias: "SignetAI", confidence: 0.9, source: "operator" },
			},
			{
				method: "DELETE",
				path: "/api/ontology/entities/entity-signet/aliases/alias-1?agent_id=ant",
				body: undefined,
			},
		]);
		expect(lines.join("\n")).toContain("Entity Aliases");
		expect(lines.join("\n")).toContain("SignetAI");
	});

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

	test("claim-evidence calls the applied claim evidence endpoint", async () => {
		let capturedPath = "";
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, path) => {
				capturedPath = path;
				return {
					ok: true,
					data: {
						items: [
							{
								attribute: {
									content: "Applied claims retain evidence.",
									status: "active",
									confidence: 0.9,
									sourcePath: "memory/codex/transcript.jsonl",
								},
								evidence: [{ kind: "memory_artifact", found: true, label: "memory/codex/transcript.jsonl" }],
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
			"claim-evidence",
			"Signet",
			"architecture",
			"ontology",
			"proposal_loop",
			"--status",
			"all",
			"--limit",
			"3",
			"--agent",
			"ant",
		]);

		expect(capturedPath).toBe(
			"/api/ontology/claims/evidence?entity=Signet&aspect=architecture&group=ontology&claim=proposal_loop&agent_id=ant&status=all&limit=3",
		);
		expect(lines.join("\n")).toContain("Claim Evidence");
		expect(lines.join("\n")).toContain("Applied claims retain evidence.");
	});

	test("link-evidence calls the applied link evidence endpoint", async () => {
		let capturedPath = "";
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, path) => {
				capturedPath = path;
				return {
					ok: true,
					data: {
						items: [{ kind: "session_transcript", found: true, label: "transcript:link" }],
					},
				};
			},
		});

		await program.parseAsync(["node", "test", "ontology", "link-evidence", "link-1", "--agent", "ant"]);

		expect(capturedPath).toBe("/api/ontology/links/link-1/evidence?agent_id=ant");
		expect(lines.join("\n")).toContain("Link Evidence");
		expect(lines.join("\n")).toContain("transcript:link");
	});

	test("extract posts source refs to the ontology extraction endpoint", async () => {
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
						source: { kind: "transcript", id: "transcript:extract" },
						count: 1,
						writtenCount: 1,
						extractionMode: "provider",
						providerName: "routing:memory_extraction",
						proposals: [
							{
								operation: "add_claim_value",
								payload: { entity: "Signet" },
								confidence: 0.9,
								rationale: "Extracted claim value candidate from source evidence.",
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
			"extract",
			"--from",
			"transcript:extract",
			"--write-proposals",
			"--use-provider",
			"--provider-timeout-ms",
			"120000",
			"--provider-max-tokens",
			"2048",
			"--agent",
			"ant",
			"--limit",
			"5",
		]);

		expect(calls).toEqual([
			{
				method: "POST",
				path: "/api/ontology/extract",
				body: {
					agent_id: "ant",
					from: "transcript:extract",
					write_proposals: true,
					use_provider: true,
					provider_timeout_ms: 120000,
					provider_max_tokens: 2048,
					created_by: "ontology-extract",
					limit: 5,
				},
			},
		]);
		expect(lines.join("\n")).toContain("Ontology Extraction");
		expect(lines.join("\n")).toContain("mode provider");
		expect(lines.join("\n")).toContain("routing:memory_extraction");
		expect(lines.join("\n")).toContain("1 written");
	});

	test("consolidate posts pending proposal consolidation requests", async () => {
		const calls: Array<{
			readonly method: string;
			readonly path: string;
			readonly body: unknown;
			readonly timeout?: number;
		}> = [];
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (method, path, body, timeout) => {
				calls.push({ method, path, body, timeout });
				return {
					ok: true,
					data: {
						sourceProposalCount: 2,
						count: 1,
						writtenCount: 0,
						consolidationMode: "provider",
						providerName: "routing:memory_extraction",
						summary: "Consolidated proposal-loop candidates.",
						proposals: [
							{
								operation: "add_claim_value",
								payload: { entity: "Signet" },
								confidence: 0.9,
								rationale: "Stable consolidated claim.",
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
			"consolidate",
			"--proposals",
			"pending",
			"--use-provider",
			"--provider-timeout-ms",
			"120000",
			"--agent",
			"ant",
			"--limit",
			"5",
		]);

		expect(calls).toEqual([
			{
				method: "POST",
				path: "/api/ontology/consolidate",
				timeout: 125000,
				body: {
					agent_id: "ant",
					status: "pending",
					write_proposals: false,
					use_provider: true,
					provider_timeout_ms: 120000,
					provider_max_tokens: undefined,
					created_by: "ontology-consolidate",
					limit: 5,
				},
			},
		]);
		expect(lines.join("\n")).toContain("Ontology Consolidation");
		expect(lines.join("\n")).toContain("mode provider");
		expect(lines.join("\n")).toContain("Stable consolidated claim");
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

	test("entity merge-plan posts a read-only merge preview request", async () => {
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
						target: { id: "entity-signet", name: "Signet", entityType: "project" },
						sources: [{ id: "entity-alias", name: "Signet Alias", entityType: "project" }],
						impact: { aspects: 1, attributes: 2, dependencies: 0, memoryMentions: 3 },
						warnings: [],
						blocked: false,
						rationale: "Merge duplicate Signet aliases.",
					},
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"entity",
			"merge-plan",
			"entity-signet",
			"entity-alias",
			"--agent",
			"ant",
		]);

		expect(calls).toEqual([
			{
				method: "POST",
				path: "/api/ontology/proposals/repair/merge-plan",
				body: {
					agent_id: "ant",
					target_entity: "entity-signet",
					source_entities: ["entity-alias"],
					force: false,
					write_proposal: false,
					created_by: "ontology-merge-plan",
					rationale: undefined,
					evidence: undefined,
				},
			},
		]);
		expect(lines.join("\n")).toContain("Entity Merge Plan");
		expect(lines.join("\n")).toContain("Signet <- Signet Alias");
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

	test("entity create posts audited operation payloads", async () => {
		const calls: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];
		console.log = () => {};
		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (method, path, body) => {
				calls.push({ method, path, body });
				return { ok: true, data: { proposal: { id: "proposal-1" }, dryRun: true } };
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"entity",
			"create",
			"Signet",
			"--type",
			"project",
			"--agent",
			"ant",
			"--dry-run",
			"--reason",
			"manual",
			"--json",
		]);

		expect(calls).toEqual([
			{
				method: "POST",
				path: "/api/ontology/operations/apply",
				body: {
					agent_id: "ant",
					actor: "operator",
					operation: "create_entity",
					payload: { name: "Signet", entity_type: "project" },
					reason: "manual",
					evidence: undefined,
					dry_run: true,
					propose: false,
				},
			},
		]);
	});

	test("claim set and stream apply use operation endpoints", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-ontology-cli-ops-"));
		const file = join(dir, "ops.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ operation: "create_entity", payload: { name: "Signet", entity_type: "project" } })}\n`,
		);
		const calls: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];
		console.log = () => {};
		try {
			const program = new Command();
			registerOntologyCommands(program, {
				ensureDaemonForSecrets: async () => true,
				secretApiCall: async (method, path, body) => {
					calls.push({ method, path, body });
					return { ok: true, data: { proposal: { id: "proposal-1" }, items: [], count: 1 } };
				},
			});

			await program.parseAsync([
				"node",
				"test",
				"ontology",
				"claim",
				"set",
				"Signet",
				"architecture",
				"ontology",
				"control_plane",
				"--value",
				"Audited operations",
				"--propose",
				"--agent",
				"ant",
			]);
			await program.parseAsync(["node", "test", "ontology", "stream", "apply", file, "--dry-run", "--json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}

		expect(calls[0]?.path).toBe("/api/ontology/operations/apply");
		expect((calls[0]?.body as { readonly operation?: string }).operation).toBe("set_claim_value");
		expect((calls[0]?.body as { readonly propose?: boolean }).propose).toBe(true);
		expect(calls[1]?.path).toBe("/api/ontology/operations/batch");
		expect((calls[1]?.body as { readonly dry_run?: boolean }).dry_run).toBe(true);
		expect((calls[1]?.body as { readonly operations?: readonly unknown[] }).operations).toHaveLength(1);
	});

	test("claim version commands call version read and archive/restore operation endpoints", async () => {
		const calls: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];
		console.log = () => {};
		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (method, path, body) => {
				calls.push({ method, path, body });
				return { ok: true, data: { proposal: { id: "proposal-1" }, items: [], count: 1 } };
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"claim",
			"versions",
			"Signet",
			"architecture",
			"ontology",
			"control_plane",
			"--agent",
			"ant",
		]);
		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"claim",
			"show",
			"Signet",
			"architecture",
			"ontology",
			"control_plane",
			"--version",
			"2",
			"--agent",
			"ant",
		]);
		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"claim",
			"archive",
			"--attribute-id",
			"attr-1",
			"--reason",
			"obsolete",
		]);
		await program.parseAsync(["node", "test", "ontology", "claim", "restore", "--attribute-id", "attr-1"]);

		expect(calls[0]?.path).toBe(
			"/api/ontology/claims/versions?entity=Signet&aspect=architecture&group=ontology&claim=control_plane&agent_id=ant",
		);
		expect(calls[1]?.path).toBe(
			"/api/ontology/claims/version?entity=Signet&aspect=architecture&group=ontology&claim=control_plane&version=2&agent_id=ant",
		);
		expect((calls[2]?.body as { readonly operation?: string }).operation).toBe("archive_claim_value");
		expect((calls[3]?.body as { readonly operation?: string }).operation).toBe("restore_claim_version");
	});

	test("aspect and link commands hit audited operation endpoints", async () => {
		const calls: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];
		console.log = () => {};
		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (method, path, body) => {
				calls.push({ method, path, body });
				return { ok: true, data: { proposal: { id: "proposal-1" } } };
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"aspect",
			"create",
			"Signet",
			"architecture",
			"--agent",
			"ant",
			"--dry-run",
		]);
		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"aspect",
			"rename",
			"Signet",
			"architecture",
			"design",
			"--propose",
		]);
		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"aspect",
			"archive",
			"Signet",
			"design",
			"--reason",
			"obsolete",
		]);
		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"link",
			"create",
			"Signet",
			"supports_claim",
			"Transcript",
			"--strength",
			"0.8",
			"--confidence",
			"0.9",
		]);
		await program.parseAsync(["node", "test", "ontology", "link", "update", "link-1", "--type", "related_to"]);
		await program.parseAsync(["node", "test", "ontology", "link", "archive", "link-1", "--reason", "obsolete"]);

		expect(calls.map((call) => (call.body as { readonly operation?: string }).operation)).toEqual([
			"create_aspect",
			"rename_aspect",
			"archive_aspect",
			"create_link",
			"update_link",
			"archive_link",
		]);
		expect((calls[0]?.body as { readonly agent_id?: string; readonly dry_run?: boolean }).agent_id).toBe("ant");
		expect((calls[0]?.body as { readonly dry_run?: boolean }).dry_run).toBe(true);
		expect((calls[1]?.body as { readonly propose?: boolean }).propose).toBe(true);
		expect((calls[3]?.body as { readonly payload?: { readonly strength?: number } }).payload?.strength).toBe(0.8);
	});

	test("pipeline explain reads daemon status", async () => {
		let capturedPath = "";
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};
		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, path) => {
				capturedPath = path;
				return {
					ok: true,
					data: {
						pipelineV2: {
							enabled: true,
							shadowMode: false,
							mutationsFrozen: false,
							graph: { enabled: true, extractionWritesEnabled: false },
							traversal: { enabled: true },
							autonomous: { enabled: true, frozen: false, allowUpdateDelete: false },
						},
					},
				};
			},
		});

		await program.parseAsync(["node", "test", "ontology", "pipeline", "explain", "--json"]);

		expect(capturedPath).toBe("/api/status");
		const data = JSON.parse(lines.join("\n")) as {
			readonly directOperations?: string;
			readonly generatedChanges?: string;
		};
		expect(data.directOperations).toContain("apply first");
		expect(data.directOperations).toContain("provenance");
		expect(data.generatedChanges).toContain("pending proposals only for large refactors");
	});

	test("assertion commands use epistemic assertion endpoints", async () => {
		const calls: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];
		let daemonChecks = 0;
		console.log = () => {};
		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => {
				daemonChecks += 1;
				return true;
			},
			secretApiCall: async (method, path, body) => {
				calls.push({ method, path, body });
				return {
					ok: true,
					data: {
						id: "assertion-1",
						subjectEntityName: "Signet",
						predicate: "claims",
						content: "Signet tracks attributed claims.",
						confidence: 0.9,
						status: "active",
					},
				};
			},
		});

		await program.parseAsync(["node", "test", "ontology", "assertions", "--entity", "Signet", "--agent", "ant"]);
		await program.parseAsync(["node", "test", "ontology", "assertion", "show", "assertion-1", "--agent", "ant"]);
		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"assertion",
			"create",
			"--entity",
			"Signet",
			"--predicate",
			"claims",
			"--content",
			"Signet tracks attributed claims.",
			"--source-kind",
			"transcript",
			"--confidence",
			"0.9",
		]);
		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"assertion",
			"link-claim",
			"assertion-1",
			"--attribute-id",
			"attr-1",
		]);
		await program.parseAsync(["node", "test", "ontology", "assertion", "archive", "assertion-1", "--reason", "stale"]);
		await program.parseAsync([
			"node",
			"test",
			"ontology",
			"assertion",
			"supersede",
			"assertion-1",
			"--content",
			"Signet tracks attributed assertions.",
			"--source-kind",
			"transcript",
		]);

		expect(calls[0]?.path).toBe("/api/ontology/assertions?entity=Signet&status=active&agent_id=ant");
		expect(calls[1]?.path).toBe("/api/ontology/assertions/assertion-1?agent_id=ant");
		expect(calls[2]?.path).toBe("/api/ontology/assertions");
		expect((calls[2]?.body as { readonly predicate?: string; readonly confidence?: number }).predicate).toBe("claims");
		expect((calls[2]?.body as { readonly confidence?: number }).confidence).toBe(0.9);
		expect(calls[3]?.path).toBe("/api/ontology/assertions/assertion-1/link-claim");
		expect(calls[4]?.path).toBe("/api/ontology/assertions/assertion-1/archive");
		expect(calls[5]?.path).toBe("/api/ontology/assertions/assertion-1/supersede");
		expect(daemonChecks).toBe(calls.length);
	});

	test("config show makes the audited operation surface explicit", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};
		const program = new Command();
		registerOntologyCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async () => ({ ok: true, data: {} }),
		});

		await program.parseAsync(["node", "test", "ontology", "config", "show", "--json"]);

		const data = JSON.parse(lines.join("\n")) as {
			readonly operationsUsable?: boolean;
			readonly operationSurface?: {
				readonly applyFirst?: boolean;
				readonly propose?: boolean;
				readonly refactorProposals?: boolean;
				readonly provenanceRequired?: boolean;
				readonly auditedThrough?: string;
			};
			readonly policyFile?: { readonly active?: boolean };
		};
		expect(data.operationsUsable).toBe(true);
		expect(data.operationSurface?.applyFirst).toBe(true);
		expect(data.operationSurface?.propose).toBe(true);
		expect(data.operationSurface?.refactorProposals).toBe(true);
		expect(data.operationSurface?.provenanceRequired).toBe(true);
		expect(data.operationSurface?.auditedThrough).toBe("ontology_proposals");
		expect(data.policyFile?.active).toBe(false);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerKnowledgeCommands } from "./knowledge";

const prevLog = console.log;
const prevError = console.error;

afterEach(() => {
	console.log = prevLog;
	console.error = prevError;
});

describe("registerKnowledgeCommands", () => {
	test("knowledge tree calls the navigation tree endpoint", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const calls: Array<{ method: string; path: string }> = [];
		const program = new Command();
		registerKnowledgeCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (method, path) => {
				calls.push({ method, path });
				return {
					ok: true,
					data: {
						entity: { name: "Nicholai" },
						items: [
							{
								aspect: { name: "food" },
								attributeCount: 2,
								constraintCount: 0,
								groupCount: 1,
								claimCount: 1,
								groups: [
									{
										groupKey: "restaurants",
										attributeCount: 2,
										constraintCount: 0,
										claimCount: 1,
										claims: [
											{
												claimKey: "favorite_restaurant",
												activeCount: 1,
												supersededCount: 1,
												preview: "Nicholai currently prefers Temaki Den.",
											},
										],
									},
								],
							},
						],
					},
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"knowledge",
			"tree",
			"Nicholai",
			"--depth",
			"3",
			"--max-aspects",
			"4",
			"--max-groups",
			"5",
			"--max-claims",
			"6",
			"--agent",
			"default",
		]);

		expect(calls).toEqual([
			{
				method: "GET",
				path: "/api/knowledge/navigation/tree?entity=Nicholai&depth=3&max_aspects=4&max_groups=5&max_claims=6&agent_id=default",
			},
		]);
		expect(lines.join("\n")).toContain("Knowledge Tree");
		expect(lines.join("\n")).toContain("favorite_restaurant");
	});

	test("knowledge tree without an entity lists entities", async () => {
		let capturedPath = "";
		const program = new Command();
		registerKnowledgeCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, path) => {
				capturedPath = path;
				return {
					ok: true,
					data: {
						items: [{ entity: { name: "Nicholai", entityType: "person" }, aspectCount: 2 }],
					},
				};
			},
		});

		console.log = () => {};
		await program.parseAsync(["node", "test", "knowledge", "tree", "--max-aspects", "7"]);

		expect(capturedPath).toBe("/api/knowledge/navigation/entities?limit=7");
	});

	test("attributes forwards path filters and json output", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		let capturedPath = "";
		const program = new Command();
		registerKnowledgeCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, path) => {
				capturedPath = path;
				return {
					ok: true,
					data: {
						items: [{ content: "Nicholai currently prefers Temaki Den.", status: "active" }],
					},
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"knowledge",
			"attributes",
			"Nicholai",
			"food",
			"restaurants",
			"favorite_restaurant",
			"--status",
			"all",
			"--kind",
			"attribute",
			"--limit",
			"5",
			"--json",
		]);

		expect(capturedPath).toBe(
			"/api/knowledge/navigation/attributes?entity=Nicholai&aspect=food&group=restaurants&claim=favorite_restaurant&status=all&kind=attribute&limit=5",
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Temaki Den");
	});

	test("knowledge hygiene calls the report-only endpoint", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		let capturedPath = "";
		const program = new Command();
		registerKnowledgeCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, path) => {
				capturedPath = path;
				return {
					ok: true,
					data: {
						suspiciousEntities: [{ name: "The", reason: "generic_word" }],
						duplicateEntities: [],
						attributeSummary: {
							missingGroupKey: 0,
							missingClaimKey: 0,
							missingSourceMemory: 0,
						},
						safeMentionCandidates: [],
					},
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"knowledge",
			"hygiene",
			"--limit",
			"3",
			"--memory-limit",
			"4",
			"--agent",
			"default",
		]);

		expect(capturedPath).toBe("/api/knowledge/hygiene?limit=3&memory_limit=4&agent_id=default");
		expect(lines.join("\n")).toContain("Knowledge Hygiene Report");
		expect(lines.join("\n")).toContain("The");
	});
});

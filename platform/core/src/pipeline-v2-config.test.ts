import { describe, expect, test } from "bun:test";
import {
	PIPELINE_V2_CONFIG_ALIASES,
	PIPELINE_V2_CONFIG_MIGRATION,
	PIPELINE_V2_MAINTENANCE_MODES,
	pipelineV2BooleanAliasPath,
	pipelineV2MaintenanceModePath,
	resolvePipelineV2BooleanAlias,
	resolvePipelineV2MaintenanceMode,
	type PipelineV2BooleanAlias,
} from "./pipeline-v2-config";

function configWithAlias(
	alias: PipelineV2BooleanAlias,
	nestedValue?: unknown,
	flatValue?: unknown,
): Record<string, unknown> {
	const pipeline: Record<string, unknown> = {};
	const aliasConfig = PIPELINE_V2_CONFIG_ALIASES[alias];
	let parent = pipeline;
	for (const key of aliasConfig.nestedPath.slice(0, -1)) {
		const next: Record<string, unknown> = {};
		parent[key] = next;
		parent = next;
	}
	const nestedKey = aliasConfig.nestedPath[aliasConfig.nestedPath.length - 1];
	if (nestedValue !== undefined) parent[nestedKey] = nestedValue;
	if (flatValue !== undefined) pipeline[alias] = flatValue;
	return { memory: { pipelineV2: pipeline } };
}

describe("pipelineV2 alias contract", () => {
	test("keeps alias names, runtime defaults, and migration behavior in one registry", () => {
		expect(Object.keys(PIPELINE_V2_CONFIG_ALIASES)).toEqual([
			"graphEnabled",
			"rerankerEnabled",
			"rerankerUseExtractionModel",
			"autonomousEnabled",
			"autonomousFrozen",
			"allowUpdateDelete",
			"maintenanceMode",
		]);
		expect(
			Object.fromEntries(Object.entries(PIPELINE_V2_CONFIG_ALIASES).map(([name, alias]) => [name, alias.nestedPath])),
		).toEqual({
			graphEnabled: ["graph", "enabled"],
			rerankerEnabled: ["reranker", "enabled"],
			rerankerUseExtractionModel: ["reranker", "useExtractionModel"],
			autonomousEnabled: ["autonomous", "enabled"],
			autonomousFrozen: ["autonomous", "frozen"],
			allowUpdateDelete: ["autonomous", "allowUpdateDelete"],
			maintenanceMode: ["autonomous", "maintenanceMode"],
		});
		expect(PIPELINE_V2_CONFIG_MIGRATION.flatFalseToTrue).toEqual([
			"graphEnabled",
			"rerankerEnabled",
			"autonomousEnabled",
			"allowUpdateDelete",
		]);
		expect(PIPELINE_V2_CONFIG_MIGRATION.nestedEnabledFalseToTrue).toEqual(["graph", "reranker", "autonomous"]);
	});

	test("resolves strict nested booleans before flat aliases and defaults", () => {
		const aliases: readonly [PipelineV2BooleanAlias, boolean][] = [
			["graphEnabled", true],
			["rerankerEnabled", true],
			["rerankerUseExtractionModel", false],
			["autonomousEnabled", true],
			["autonomousFrozen", false],
			["allowUpdateDelete", true],
		];

		for (const [alias, expectedDefault] of aliases) {
			expect(resolvePipelineV2BooleanAlias({}, alias)).toBe(expectedDefault);
			expect(resolvePipelineV2BooleanAlias(configWithAlias(alias, false, true), alias)).toBe(false);
			expect(resolvePipelineV2BooleanAlias(configWithAlias(alias, "false", true), alias)).toBe(true);
			expect(resolvePipelineV2BooleanAlias(configWithAlias(alias, false), alias)).toBe(false);
			expect(resolvePipelineV2BooleanAlias(configWithAlias(alias, undefined, false), alias)).toBe(false);
		}
	});

	test("selects the existing boolean form for reads and writes", () => {
		expect(pipelineV2BooleanAliasPath(configWithAlias("graphEnabled", false, true), "graphEnabled")).toEqual([
			"memory",
			"pipelineV2",
			"graph",
			"enabled",
		]);
		expect(
			pipelineV2BooleanAliasPath(configWithAlias("autonomousEnabled", "invalid", false), "autonomousEnabled"),
		).toEqual(["memory", "pipelineV2", "autonomousEnabled"]);
		expect(pipelineV2BooleanAliasPath({}, "allowUpdateDelete")).toEqual([
			"memory",
			"pipelineV2",
			"autonomous",
			"allowUpdateDelete",
		]);
	});

	test("maintenance mode applies nullish precedence before validating the selected value", () => {
		expect(PIPELINE_V2_MAINTENANCE_MODES).toEqual(["observe", "execute"]);
		expect(
			resolvePipelineV2MaintenanceMode({
				memory: { pipelineV2: { autonomous: { maintenanceMode: "observe" }, maintenanceMode: "execute" } },
			}),
		).toBe("observe");
		expect(
			resolvePipelineV2MaintenanceMode({
				memory: { pipelineV2: { autonomous: { maintenanceMode: "invalid" }, maintenanceMode: "observe" } },
			}),
		).toBe("execute");
		expect(
			resolvePipelineV2MaintenanceMode({
				memory: { pipelineV2: { autonomous: { maintenanceMode: null }, maintenanceMode: "observe" } },
			}),
		).toBe("observe");
		expect(
			resolvePipelineV2MaintenanceMode({
				memory: { pipelineV2: { autonomous: { maintenanceMode: 5 }, maintenanceMode: "observe" } },
			}),
		).toBe("execute");
		expect(resolvePipelineV2MaintenanceMode({})).toBe("execute");
	});

	test("keeps maintenance-mode reads and writes on the selected nested or flat form", () => {
		expect(
			pipelineV2MaintenanceModePath({
				memory: { pipelineV2: { autonomous: { maintenanceMode: "invalid" }, maintenanceMode: "observe" } },
			}),
		).toEqual(["memory", "pipelineV2", "autonomous", "maintenanceMode"]);
		expect(
			pipelineV2MaintenanceModePath({
				memory: { pipelineV2: { autonomous: { maintenanceMode: null }, maintenanceMode: "observe" } },
			}),
		).toEqual(["memory", "pipelineV2", "maintenanceMode"]);
	});
});

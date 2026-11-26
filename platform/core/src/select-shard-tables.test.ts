import { expect, test } from "bun:test";
import * as shards from "./compartment-shards";

test("selectShardTables admits only readable physical shard names and rejects shadow tables", () => {
	expect("selectShardTables" in shards).toBe(true);
	if (!("selectShardTables" in shards) || typeof shards.selectShardTables !== "function")
		throw new Error("Missing pure shard selector");
	const names = [
		"memories_fts__c10",
		"memories_fts__c2",
		"memories_fts",
		"memories_fts__c02",
		"memories_fts__c2_data",
		"vec_embeddings__c10",
		"vec_embeddings",
		"untrusted;DROP TABLE memories",
	];
	expect(shards.selectShardTables(names, [10])).toEqual([
		"memories_fts",
		"memories_fts__c10",
		"vec_embeddings",
		"vec_embeddings__c10",
	]);
	expect(shards.selectShardTables(names, [])).toEqual(["memories_fts", "vec_embeddings"]);
	expect(shards.selectShardTables(names, "all")).toEqual([
		"memories_fts",
		"memories_fts__c2",
		"memories_fts__c10",
		"vec_embeddings",
		"vec_embeddings__c10",
	]);
});

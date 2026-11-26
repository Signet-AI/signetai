import "../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { createStagingOwner } from "./staged-upload-owner";

for (const state of ["sealed", "consumed"] as const) {
	test(`staging seal explicitly discriminates ${state} metadata`, async () => {
		const row = {
			upload_generation: 0,
			upload_offset: 3,
			upload_size: 3,
			upload_digest: "",
			storage_state: state,
			content_hash: "a".repeat(64),
			result_json: state === "consumed" ? '{"queued":true}' : null,
		};
		const unavailable = async () => {
			throw new Error("Sealed metadata does not require a storage mutation");
		};
		const staging = createStagingOwner<
			{ readonly signal?: AbortSignal },
			{ generation: number; readonly signal?: AbortSignal },
			typeof row
		>({
			get: async () => row,
			databasePath: unavailable,
			declare: unavailable,
			append: unavailable,
			read: unavailable,
			seal: unavailable,
			beginPurge: unavailable,
			purgeBatch: unavailable,
			finishPurge: unavailable,
		});
		const result = await staging.seal({ generation: 0 });
		expect(result.kind).toBe(state);
		expect(result.upload.result_json).toBe(row.result_json);
	});
}

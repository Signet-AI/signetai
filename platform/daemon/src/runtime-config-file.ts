import { type FileHandle, open, lstat } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivateWrite } from "@signet/sdk/node";
import { PIPELINE_CONFIG_FILES } from "@signet/core";
import { IdentityError } from "./auth/organization-store";
import { constants } from "node:fs";
const MAX_CONFIG_BYTES = 1_048_576;
export async function readRuntimeConfigFile(agentsDir: string, refuseSymlinks = false) {
	for (const name of PIPELINE_CONFIG_FILES) {
		const file = join(agentsDir, name);
		let handle: FileHandle;
		try {
			if (refuseSymlinks && (await lstat(file)).isSymbolicLink()) throw new IdentityError(409, "config_symlink");
			handle = await open(file, refuseSymlinks ? constants.O_RDONLY | constants.O_NOFOLLOW : "r");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		try {
			const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
			let offset = 0;
			const deadline = Date.now() + 5000;
			while (offset < buffer.length) {
				if (Date.now() >= deadline) throw new IdentityError(503, "config_read_deadline");
				const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
				if (!bytesRead) break;
				offset += bytesRead;
			}
			if (offset > MAX_CONFIG_BYTES) throw new IdentityError(413, "config_too_large");
			return { file, text: buffer.subarray(0, offset).toString("utf8") };
		} finally {
			await handle.close();
		}
	}
	throw new IdentityError(404, "config_not_found", "No Signet config file found");
}

export async function publishRuntimeConfigFile(file: string, text: string): Promise<void> {
	if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new IdentityError(413, "config_too_large");
	const info = await lstat(file).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	});
	if (info?.isSymbolicLink()) throw new IdentityError(409, "config_symlink");
	await atomicPrivateWrite(file, text);
}

import { randomUUID } from "node:crypto";
import { type FileHandle, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PIPELINE_CONFIG_FILES } from "@signet/core";
import { IdentityError } from "./auth/organization-store";
const MAX_CONFIG_BYTES = 1_048_576;
export async function readRuntimeConfigFile(agentsDir: string) {
	for (const name of PIPELINE_CONFIG_FILES) {
		const file = join(agentsDir, name);
		let handle: FileHandle;
		try {
			handle = await open(file, "r");
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
	const temporary = `${file}.pause-${randomUUID()}`;
	const handle = await open(temporary, "wx", 0o600);
	let pending = true;
	try {
		try {
			await handle.writeFile(text);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, file);
		pending = false;
		if (process.platform !== "win32") {
			const directory = await open(dirname(file), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	} finally {
		if (pending) await unlink(temporary);
	}
}

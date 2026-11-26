import { open, rename, unlink, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveWorkspaceLayout } from "@signet/core";
export function setupTokenPath(agentsDir: string) {
	return join(resolveWorkspaceLayout(agentsDir).runtime, "setup-token");
}
export async function publishSetupToken(agentsDir: string, token: string) {
	const directory = resolveWorkspaceLayout(agentsDir).runtime;
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = setupTokenPath(agentsDir),
		temporary = `${path}.${randomUUID()}`;
	const file = await open(temporary, "wx", 0o600);
	let pending = true;
	try {
		try {
			await file.writeFile(token);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
		pending = false;
	} finally {
		if (pending) await unlink(temporary);
	}
}

export async function removeSetupToken(agentsDir: string) {
	try {
		await unlink(setupTokenPath(agentsDir));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
}

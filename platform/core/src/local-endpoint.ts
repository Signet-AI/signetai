import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function workspaceSocketPath(
	workspace: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	if (process.platform === "win32" || !process.getuid)
		throw new Error("Current-user-only local endpoint unavailable on Windows");
	const hash = createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 16);
	const limit = process.platform === "darwin" ? 104 : 108;
	const runtime = env.XDG_RUNTIME_DIR;
	if (runtime) {
		const path = join(runtime, "signet", `${hash}.sock`);
		if (Buffer.byteLength(path) < limit) return path;
	}
	const path = join(env.TMPDIR ?? tmpdir(), `signet-${process.getuid()}`, `${hash}.sock`);
	if (Buffer.byteLength(path) >= limit) throw new Error("Local socket path exceeds sun_path limit");
	return path;
}

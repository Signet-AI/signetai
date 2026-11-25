import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function connectorRegistryKey(
	harness: string,
	profileHome?: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	if (harness !== "hermes-agent") return harness;
	const defaultHome = resolve(join(env.HOME ?? homedir(), ".hermes"));
	const home = resolve(profileHome ?? env.HERMES_HOME ?? defaultHome);
	if (home === defaultHome) return harness;
	return `${harness}.${createHash("sha256").update(home).digest("hex").slice(0, 16)}`;
}

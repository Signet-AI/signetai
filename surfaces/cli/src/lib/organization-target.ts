import { resolveSignetDaemonUrl } from "@signet/core/daemon-url";
import type { Command } from "commander";
import {
	NodeTransport,
	resolveTarget,
	type ResolvedTarget,
	type ResolveTargetOptions,
} from "../../../../libs/sdk/src/node.js";

export interface CliTargetOptions {
	readonly local?: boolean;
	readonly org?: boolean;
	readonly url?: string;
	readonly agent?: string;
	readonly nonInteractive?: boolean;
	readonly join?: string;
}
let selected: ResolvedTarget | undefined;
let transport: NodeTransport | undefined;
let selectedAgent: string | undefined;
export function cliTarget(): ResolvedTarget | undefined {
	return selected;
}
export function cliTransport(): NodeTransport | undefined {
	return transport;
}
export function cliAgent(): string | undefined {
	return selectedAgent;
}
export async function resolveCliTarget(
	options: CliTargetOptions,
	deps: ResolveTargetOptions = {},
): Promise<ResolvedTarget> {
	if (options.local && (options.org || options.url)) throw new Error("--local cannot be combined with --org or --url");
	if (options.local) {
		const env = deps.env ?? process.env;
		const url = resolveSignetDaemonUrl({ env: { SIGNET_HOST: "127.0.0.1", SIGNET_PORT: env.SIGNET_PORT } });
		return { url, origin: new URL(url).origin, remote: false, credential: { source: "none", get: async () => null } };
	}
	if (
		options.nonInteractive &&
		!options.org &&
		!options.url &&
		!deps.flagUrl &&
		!deps.configUrl &&
		!(deps.env ?? process.env).SIGNET_DAEMON_URL &&
		!(deps.env ?? process.env).SIGNET_API_KEY &&
		!(deps.env ?? process.env).SIGNET_API_KEY_FILE
	)
		return resolveCliTarget({ local: true }, deps);
	const target = await resolveTarget({
		...deps,
		flagUrl: options.url ?? deps.flagUrl,
		...(options.nonInteractive
			? {
					keyring: {
						get: async () => {
							throw new Error(
								"Keychain access requires interactive mode; provide an environment credential or protected key file",
							);
						},
						set: async () => {
							throw new Error("Keychain writes require interactive mode");
						},
					},
				}
			: {}),
	});
	if (options.org && !target.remote)
		throw new Error("No organization instance is configured. Run `signet login --url <url>`.");
	return target;
}
export function localOnlyMessage(name: string): string {
	return `This manages a local daemon. Your current target is \`${name}\` (remote). Pass \`--local\`, or run it on the instance host.`;
}
export function registerOrganizationTarget(program: Command, deps: ResolveTargetOptions = {}): void {
	selected = undefined;
	transport = undefined;
	selectedAgent = undefined;
	program
		.option("--org", "Use the signed-in organization")
		.option("--local", "Use the local workspace")
		.option("--url <url>", "Override the instance URL")
		.option("--agent <id>", "Agent for this request")
		.option("--non-interactive", "Never open a browser or prompt");
	program.hook("preAction", async (_root, command) => {
		let top = command;
		while (top.parent && top.parent !== program) top = top.parent;
		if (["hook", "connect", "disconnect", "connector"].includes(top.name())) return;
		const options = command.optsWithGlobals<CliTargetOptions>();
		selected = await resolveCliTarget({ ...options, url: options.join ?? options.url }, deps);
		selectedAgent = options.agent;
		transport = selected.remote ? new NodeTransport(selected, { env: deps.env }) : undefined;
		if (selected.remote && top.name() === "import" && !selectedAgent)
			throw new Error("Organization imports require --agent <id>.");
		if (selected.remote && top.name() === "import")
			throw new Error("Remote portable bundles are not available yet. No local database was opened.");

		if (
			selected.remote &&
			[
				"start",
				"stop",
				"install",
				"setup",
				"migrate-schema",
				"migrate-vectors",
				"git",
				"sync",
				"workspace",
				"configure",
			].includes(top.name()) &&
			!(top.name() === "setup" && command.opts().join)
		)
			throw new Error(localOnlyMessage(new URL(selected.url).hostname));
		if (selected.remote && top.name() === "daemon" && ["start", "stop", "install"].includes(command.name()))
			throw new Error(localOnlyMessage(new URL(selected.url).hostname));
	});
}

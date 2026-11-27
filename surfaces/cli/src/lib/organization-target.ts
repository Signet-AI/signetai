import { SignetError } from "../../../../libs/sdk/src/index.js";
import { resolveSignetDaemonUrl } from "@signet/core/daemon-url";
import type { Command } from "commander";
import {
	NodeTransport,
	resolveTarget,
	type ResolvedTarget,
	type ResolveTargetOptions,
} from "../../../../libs/sdk/src/node.js";

export interface CliTargetOptions {
	readonly json?: boolean;
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
export function credentialOptions<T extends ResolveTargetOptions>(deps: T, nonInteractive: boolean): T {
	if (!nonInteractive) return deps;
	return {
		...deps,
		keyring: {
			get: async () => {
				throw new SignetError(
					"Keychain access requires interactive mode; provide an environment credential or protected key file",
					"interactive_required",
				);
			},
			set: async () => {
				throw new SignetError("Keychain writes require interactive mode", "interactive_required");
			},
		},
	};
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
	const target = await resolveTarget(
		credentialOptions({ ...deps, flagUrl: options.url ?? deps.flagUrl }, options.nonInteractive === true),
	);
	if (options.org && !target.remote)
		throw new Error("No organization instance is configured. Run `signet login --url <url>`.");
	return target;
}
export function localOnlyMessage(name: string): string {
	return `This manages a local daemon. Your current target is \`${name}\` (remote). Pass \`--local\`, or run it on the instance host.`;
}
function registerTargetFlags(command: Command): void {
	command.enablePositionalOptions();
	const inherited = command.parent?.opts<CliTargetOptions>();
	for (const [key, flags, description] of [
		["json", "--json", "Use JSON where supported and structure command errors"],
		["org", "--org", "Use the signed-in organization"],
		["local", "--local", "Use the local workspace"],
		["url", "--url <url>", "Override the instance URL"],
		["agent", "--agent <id>", "Agent for this request"],
		["nonInteractive", "--non-interactive", "Never open a browser or prompt"],
	] as const) {
		if (!command.options.some((option) => option.attributeName() === key)) command.option(flags, description);
		const value = inherited?.[key];
		if (value !== undefined) command.setOptionValueWithSource(key, value, "cli");
	}
	command.hook("preSubcommand", (_parent, child) => registerTargetFlags(child));
}
const remoteCommands = new Set([
	"login",
	"logout",
	"whoami",
	"dashboard",
	"status",
	"restart",
	"pause",
	"resume",
	"logs",
	"remember",
	"recall",
	"import",
	"export",
	"export transcripts",
	"daemon restart",
	"daemon pause",
	"daemon resume",
	"daemon status",
	"daemon logs",
	"embed audit",
	"embed backfill",
	"repair queue requeue",
	"repair queue cancel",
	"repair queue prune",
	"agent use",
	"agent transfer",
	"agent list",
	"agent add",
	"agent remove",
	"agent purge",
	"agent info",
	"agent show",
	"agent set",
	"secret put",
	"secret list",
	"secret delete",
	"secret get",
	"secret has",
	"secret exec",
	"secret exec-status",
	"api-key create",
	"api-key list",
	"api-key revoke",
	"auth sso set",
	"auth devices",
	"auth devices revoke",
	"auth devices rename",
	"auth sessions",
	"auth sessions revoke",
	"org users list",
	"org users invite",
	"org users role",
	"org users reactivate",
	"org users deactivate",
	"org teams list",
	"org teams create",
	"org teams show",
	"org teams delete",
	"org teams rename",
	"org teams add",
	"org teams remove",
	"org access",
	"org jobs",
	"org agents list",
	"audit",
	"classification list",
	"classification create",
	"classification audience",
	"classify",
]);
export function registerOrganizationTarget(program: Command, deps: ResolveTargetOptions = {}): void {
	selected = undefined;
	transport = undefined;
	selectedAgent = undefined;
	registerTargetFlags(program);
	program.hook("preAction", async (_root, command) => {
		for (const name of ["json", "nonInteractive"]) {
			if (program.getOptionValue(name) === true) command.setOptionValueWithSource(name, true, "cli");
		}
		let top = command;
		while (top.parent && top.parent !== program) top = top.parent;
		if (["hook", "connect", "disconnect", "connector"].includes(top.name())) return;
		const options = command.opts<CliTargetOptions>();
		if (options.nonInteractive && top.name() === "dashboard")
			throw new SignetError("Browser opening is disabled by --non-interactive", "non_interactive");
		selected = await resolveCliTarget({ ...options, url: options.join ?? options.url }, deps);
		selectedAgent = options.agent;
		transport = selected.remote ? new NodeTransport(selected, { env: deps.env }) : undefined;
		if (selected.remote && top.name() === "import" && !selectedAgent)
			throw new Error("Organization imports require --agent <id>.");

		const path: string[] = [];
		for (let node: Command | null = command; node && node !== program; node = node.parent) path.unshift(node.name());
		if (selected.remote && !remoteCommands.has(path.join(" ")) && !(top.name() === "setup" && options.join))
			throw new Error(localOnlyMessage(new URL(selected.url).hostname));
	});
}

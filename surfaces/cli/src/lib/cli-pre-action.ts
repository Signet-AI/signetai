import { existsSync } from "node:fs";
import type { Command } from "commander";

export interface CliPreActionDeps {
	readonly agentsDir: string;
	readonly version: string;
	readonly recordCommandInvoked: (agentsDir: string, commandName: string) => void;
	readonly flushCliTelemetry: (agentsDir: string, version: string) => Promise<void>;
	readonly ensureOpenClawPluginPackage: (
		agentsDir: string,
		options: { readonly silent: true },
	) => Promise<string | undefined>;
}

export function registerCliPreAction(program: Command, deps: CliPreActionDeps): void {
	program.hook("preAction", async (_thisCommand, actionCommand) => {
		let current: Command | null = actionCommand;
		let topLevelCommand = "";

		while (current?.parent) {
			if (current.parent.name() === "signet") {
				topLevelCommand = current.name();
				break;
			}
			current = current.parent;
		}

		if (actionCommand.name() === "signet" || topLevelCommand === "") return;
		if (["hook", "setup", "migration"].includes(topLevelCommand)) return;
		if (!existsSync(deps.agentsDir)) return;

		deps.recordCommandInvoked(deps.agentsDir, topLevelCommand);
		void deps.flushCliTelemetry(deps.agentsDir, deps.version);

		if (topLevelCommand === "status" || topLevelCommand === "dashboard") return;
		await deps.ensureOpenClawPluginPackage(deps.agentsDir, { silent: true });
	});
}

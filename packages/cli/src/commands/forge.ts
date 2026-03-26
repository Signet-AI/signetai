import type { Command } from "commander";
import { withJson } from "./shared.js";

interface ForgeStatusOptions {
	json?: boolean;
}

interface ForgeInstallOptions {
	version?: string;
}

interface ForgeDeps {
	readonly doctorForge: (options: ForgeStatusOptions) => Promise<void>;
	readonly installForge: (options: ForgeInstallOptions) => Promise<void>;
	readonly showForgeStatus: (options: ForgeStatusOptions) => Promise<void>;
	readonly updateForge: (options: ForgeInstallOptions) => Promise<void>;
}

export function registerForgeCommands(program: Command, deps: ForgeDeps): void {
	const forgeCmd = program.command("forge").description("Manage the first-party Forge harness");

	forgeCmd
		.command("install")
		.description("Install Forge from Signet first-party releases")
		.option("--version <version>", "Install a specific Forge version")
		.action(deps.installForge);

	forgeCmd
		.command("update")
		.description("Update Forge to the latest managed release")
		.option("--version <version>", "Update to a specific Forge version")
		.action(deps.updateForge);

	const status = forgeCmd.command("status").description("Show Forge installation status").action(deps.showForgeStatus);
	withJson(status);

	const doctor = forgeCmd.command("doctor").description("Check Forge runtime health").action(deps.doctorForge);
	withJson(doctor);
}

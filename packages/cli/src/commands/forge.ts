import type { Command } from "commander";
import { withJson, withPath } from "./shared.js";

interface ForgeStatusOptions {
	json?: boolean;
}

interface ForgeInstallOptions {
	version?: string;
	yes?: boolean;
}

interface ForgeServiceOptions {
	json?: boolean;
	path?: string;
}

interface ForgeDeps {
	readonly doctorForge: (options: ForgeStatusOptions) => Promise<void>;
	readonly installForge: (options: ForgeInstallOptions) => Promise<void>;
	readonly restartForgeService: (options: ForgeServiceOptions) => Promise<void>;
	readonly showForgeStatus: (options: ForgeStatusOptions) => Promise<void>;
	readonly showForgeServiceStatus: (options: ForgeServiceOptions) => Promise<void>;
	readonly startForgeService: (options: ForgeServiceOptions) => Promise<void>;
	readonly stopForgeService: (options: ForgeServiceOptions) => Promise<void>;
	readonly updateForge: (options: ForgeInstallOptions) => Promise<void>;
}

export function registerForgeCommands(program: Command, deps: ForgeDeps): void {
	const forgeCmd = program.command("forge").description("Manage the first-party Forge harness");

	forgeCmd
		.command("install")
		.description("Install Forge from Signet first-party releases")
		.option("--version <version>", "Install a specific Forge version")
		.option("-y, --yes", "Acknowledge Forge development warning and continue without prompt")
		.action(deps.installForge);

	forgeCmd
		.command("update")
		.description("Update Forge to the latest managed release")
		.option("--version <version>", "Update to a specific Forge version")
		.option("-y, --yes", "Acknowledge Forge development warning and continue without prompt")
		.action(deps.updateForge);

	const status = forgeCmd.command("status").description("Show Forge installation status").action(deps.showForgeStatus);
	withJson(status);

	const doctor = forgeCmd.command("doctor").description("Check Forge runtime health").action(deps.doctorForge);
	withJson(doctor);

	const service = forgeCmd.command("service").description("Manage the Forge service wrapper (Signet daemon)");

	const serviceStart = service.command("start").description("Start Forge service").action(deps.startForgeService);
	withPath(serviceStart);

	const serviceStop = service.command("stop").description("Stop Forge service").action(deps.stopForgeService);
	withPath(serviceStop);

	const serviceRestart = service
		.command("restart")
		.description("Restart Forge service")
		.action(deps.restartForgeService);
	withPath(serviceRestart);

	const serviceStatus = service
		.command("status")
		.description("Show Forge service status")
		.action(deps.showForgeServiceStatus);
	withPath(serviceStatus);
	withJson(serviceStatus);
}

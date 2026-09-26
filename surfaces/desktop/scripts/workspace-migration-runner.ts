import { createDefaultMigrationEngine } from "../../cli/src/commands/migration";

const usage = `Usage: workspace-migration-runner <status|run|rollback> --source <path> [--destination <path>]`;
const args = process.argv.slice(2);
const action = args.shift();

if (!action || action === "--help" || action === "-h") {
	console.log(usage);
} else {
	try {
		if (action !== "status" && action !== "run" && action !== "rollback")
			throw new Error(`unsupported migration action: ${action}`);
		const options: { source?: string; destination?: string } = {};
		for (let index = 0; index < args.length; index += 1) {
			const name = args[index];
			const value = args[index + 1];
			if ((name !== "--source" && name !== "--destination") || !value || value.startsWith("--"))
				throw new Error(`invalid migration option: ${name}`);
			if (name === "--source") options.source = value;
			else options.destination = value;
			index += 1;
		}
		if (!options.source) throw new Error("--source is required");
		const engine = createDefaultMigrationEngine(options);
		const result =
			action === "status"
				? await engine.status()
				: action === "rollback"
					? await engine.rollback().then(() => ({ status: "rolled-back" }))
					: await engine.run();
		console.log(JSON.stringify(result));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

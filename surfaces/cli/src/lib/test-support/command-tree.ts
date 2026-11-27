import { Command } from "commander";

Command.prototype.parseAsync = async function () {
	const walk = (command: Command, path: string[]): string[][] => [
		...(path.length ? [path] : []),
		...command.commands.flatMap((child) => walk(child, [...path, child.name()])),
	];
	console.log(JSON.stringify(walk(this, [])));
	return this;
};

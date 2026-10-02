import chalk from "chalk";

export function printCollection<T>(
	items: readonly T[],
	title: string,
	emptyMessage: string,
	printItem: (item: T) => void,
): void {
	if (items.length === 0) {
		console.log(chalk.dim(`  ${emptyMessage}`));
		return;
	}
	console.log(chalk.bold(`\n  ${title}\n`));
	for (const item of items) printItem(item);
	console.log();
}

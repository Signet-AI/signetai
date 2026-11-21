export interface HarnessPythonCommand {
	readonly executable: string;
	readonly args: readonly string[];
}

interface PythonCandidate {
	readonly name: string;
	readonly args: readonly string[];
}

export function resolveHarnessPythonCommand(
	platform: NodeJS.Platform,
	resolveExecutable: (name: string) => string | null,
	launchdExecutable?: string,
): HarnessPythonCommand | null {
	if (platform === "darwin") {
		return launchdExecutable ? { executable: launchdExecutable, args: [] } : null;
	}

	const candidates: readonly PythonCandidate[] =
		platform === "win32"
			? [
					{ name: "python", args: [] },
					{ name: "py", args: ["-3"] },
					{ name: "python3", args: [] },
				]
			: [
					{ name: "python3", args: [] },
					{ name: "python", args: [] },
				];

	for (const candidate of candidates) {
		const executable = resolveExecutable(candidate.name);
		if (executable) return { executable, args: candidate.args };
	}

	return null;
}

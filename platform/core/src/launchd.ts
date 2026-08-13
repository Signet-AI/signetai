import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const CRITICAL_EXECUTABLES = ["git", "bun", "npx", "python3"] as const;

const FALLBACK_EXECUTABLE_PATHS: Readonly<Record<(typeof CRITICAL_EXECUTABLES)[number], readonly string[]>> = {
	git: ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"],
	bun: ["/opt/homebrew/bin/bun", "/usr/local/bin/bun", "/usr/bin/bun"],
	npx: ["/opt/homebrew/bin/npx", "/usr/local/bin/npx", "/usr/bin/npx"],
	python3: ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"],
};

export interface LaunchdPlistInput {
	readonly label: string;
	readonly programArguments: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
	readonly workingDirectory: string;
	readonly standardOutPath: string;
	readonly standardErrorPath: string;
}

export interface LaunchdEnvironmentInput {
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly pathValue?: string;
	readonly home?: string;
	readonly values?: Readonly<Record<string, string>>;
}

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
}

export function resolveLaunchdExecutable(
	name: (typeof CRITICAL_EXECUTABLES)[number],
	input: Pick<LaunchdEnvironmentInput, "environment" | "pathValue" | "home"> = {},
): string {
	const environment = input.environment ?? process.env;
	const home = input.home ?? environment.HOME ?? homedir();
	const pathEntries = unique([
		...(input.pathValue ?? environment.PATH ?? "").split(delimiter),
		join(home, ".bun", "bin"),
		join(home, "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
	]);

	for (const directory of pathEntries) {
		const candidate = join(directory, name);
		if (isExecutableFile(candidate)) return candidate;
	}

	return FALLBACK_EXECUTABLE_PATHS[name].find(isExecutableFile) ?? FALLBACK_EXECUTABLE_PATHS[name][0];
}

export function buildLaunchdEnvironment(input: LaunchdEnvironmentInput = {}): Record<string, string> {
	const environment = input.environment ?? process.env;
	const home = input.home ?? environment.HOME ?? homedir();
	const basePath = input.pathValue ?? environment.PATH ?? "";
	const resolvedPaths = CRITICAL_EXECUTABLES.map((name) => dirname(resolveLaunchdExecutable(name, input)));
	const pathValue = unique([
		...resolvedPaths,
		join(home, ".bun", "bin"),
		join(home, "bin"),
		...basePath.split(delimiter),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
	]).join(delimiter);

	return {
		...input.values,
		HOME: home,
		PATH: pathValue,
	};
}

function xmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

export function buildLaunchdPlist(input: LaunchdPlistInput): string {
	const programArguments = input.programArguments.map((arg) => `\n\t\t<string>${xmlEscape(arg)}</string>`).join("");
	const environment = Object.entries(input.environment)
		.map(([key, value]) => `\n\t\t<key>${xmlEscape(key)}</key>\n\t\t<string>${xmlEscape(value)}</string>`)
		.join("");

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(input.label)}</string>
\t<key>ProgramArguments</key>
\t<array>${programArguments}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>${environment}
\t</dict>
\t<key>WorkingDirectory</key>
\t<string>${xmlEscape(input.workingDirectory)}</string>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(input.standardOutPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(input.standardErrorPath)}</string>
\t<key>ProcessType</key>
\t<string>Background</string>
</dict>
</plist>
`;
}

/**
 * Python detection and management utilities
 * Handles cross-platform Python detection, version checking,
 * and virtual environment setup with optional zvec support.
 */

import { spawn } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";

export interface PythonVersion {
	major: number;
	minor: number;
	patch: number;
	full: string;
}

export interface PythonInfo {
	path: string;
	version: PythonVersion;
	source: "system" | "pyenv" | "conda";
}

export interface PyenvInfo {
	available: boolean;
	versions: string[];
	compatibleVersions: string[];
	root?: string;
}

export interface CondaInfo {
	available: boolean;
	condaPath?: string;
	envs?: string[];
}

export interface VenvResult {
	success: boolean;
	pythonPath: string;
	pipPath: string;
	error?: string;
}

export interface InstallResult {
	success: boolean;
	error?: string;
}

export interface DepsResult {
	success: boolean;
	zvecInstalled: boolean;
	error?: string;
}

const isWindows = platform() === "win32";
const isMac = platform() === "darwin";
const isLinux = platform() === "linux";

/**
 * Parse Python version string (e.g., "Python 3.12.1")
 */
function parseVersion(output: string): PythonVersion | null {
	const match = output.match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
	if (!match) return null;
	return {
		major: parseInt(match[1], 10),
		minor: parseInt(match[2], 10),
		patch: parseInt(match[3], 10),
		full: `${match[1]}.${match[2]}.${match[3]}`,
	};
}

/**
 * Run a command and return stdout
 */
async function runCommand(
	cmd: string,
	args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		const proc = spawn(cmd, args, {
			stdio: ["pipe", "pipe", "pipe"],
			shell: isWindows,
		});
		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (c) => resolve({ code: c ?? 1, stdout, stderr }));
		proc.on("error", (e) =>
			resolve({ code: 1, stdout: "", stderr: e.message }),
		);
	});
}

/**
 * Check if a Python version is compatible with zvec (3.10-3.12)
 */
export function isZvecCompatible(version: PythonVersion): boolean {
	return version.major === 3 && version.minor >= 10 && version.minor <= 12;
}

/**
 * Detect system Python (tries multiple commands)
 */
export async function detectSystemPython(): Promise<PythonInfo | null> {
	const candidates = isWindows
		? ["py -3", "python", "python3"]
		: ["python3", "python"];

	// On macOS, prefer Homebrew Python
	if (isMac) {
		const homebrewPython =
			process.arch === "arm64"
				? "/opt/homebrew/bin/python3"
				: "/usr/local/bin/python3";
		if (existsSync(homebrewPython)) {
			candidates.unshift(homebrewPython);
		}
	}

	for (const cmd of candidates) {
		const result = await runCommand(cmd, ["--version"]);
		if (result.code === 0) {
			const version = parseVersion(result.stdout || result.stderr);
			if (version) {
				// Get the actual path
				const whichCmd = isWindows ? "where" : "which";
				const pathResult = await runCommand(whichCmd, [cmd.split(" ")[0]]);
				const pythonPath = pathResult.stdout.trim().split("\n")[0] || cmd;

				return {
					path: pythonPath,
					version,
					source: "system",
				};
			}
		}
	}

	return null;
}

/**
 * Detect pyenv installation and available Python versions
 */
export async function detectPyenv(): Promise<PyenvInfo> {
	const home = homedir();
	const pyenvRoot = process.env.PYENV_ROOT || join(home, ".pyenv");
	const pyenvPath = join(pyenvRoot, "bin", "pyenv");

	if (!existsSync(pyenvPath)) {
		// Check for pyenv-win on Windows
		if (isWindows) {
			const winPath = join(home, ".pyenv", "pyenv-win", "bin", "pyenv.bat");
			if (!existsSync(winPath)) {
				return { available: false, versions: [], compatibleVersions: [] };
			}
		} else {
			return { available: false, versions: [], compatibleVersions: [] };
		}
	}

	// Get installed versions
	const result = await runCommand(pyenvPath, ["versions", "--bare"]);
	if (result.code !== 0) {
		return {
			available: true,
			versions: [],
			compatibleVersions: [],
			root: pyenvRoot,
		};
	}

	const versions = result.stdout
		.trim()
		.split("\n")
		.filter((v) => v.trim());
	const compatibleVersions = versions.filter((v) => {
		const match = v.match(/^(\d+)\.(\d+)\.?(\d*)/);
		if (!match) return false;
		const major = parseInt(match[1], 10);
		const minor = parseInt(match[2], 10);
		return major === 3 && minor >= 10 && minor <= 12;
	});

	return {
		available: true,
		versions,
		compatibleVersions,
		root: pyenvRoot,
	};
}

/**
 * Detect conda installation
 */
export async function detectConda(): Promise<CondaInfo> {
	const result = await runCommand("conda", ["info", "--json"]);

	if (result.code !== 0) {
		return { available: false };
	}

	try {
		const info = JSON.parse(result.stdout);
		return {
			available: true,
			condaPath: info.conda_version ? "conda" : undefined,
			envs: info.envs?.map((e: string) => e.split("/").pop()) || [],
		};
	} catch {
		return { available: true };
	}
}

/**
 * Get path to pyenv Python
 */
export async function getPyenvPython(version: string): Promise<string | null> {
	const home = homedir();
	const pyenvRoot = process.env.PYENV_ROOT || join(home, ".pyenv");

	if (isWindows) {
		const winPath = join(pyenvRoot, "versions", version, "python.exe");
		return existsSync(winPath) ? winPath : null;
	}

	const unixPath = join(pyenvRoot, "versions", version, "bin", "python");
	return existsSync(unixPath) ? unixPath : null;
}

/**
 * Install pyenv (Unix only)
 */
export async function installPyenv(): Promise<InstallResult> {
	if (isWindows) {
		return {
			success: false,
			error:
				"On Windows, please install pyenv-win manually from https://pyenv-win.github.io/pyenv-win/",
		};
	}

	const result = await runCommand("curl", ["https://pyenv.run", "|", "bash"]);

	// curl | bash needs shell
	const shellResult = await runCommand("bash", [
		"-c",
		"curl https://pyenv.run | bash",
	]);

	if (shellResult.code !== 0) {
		return {
			success: false,
			error: shellResult.stderr || "Failed to install pyenv",
		};
	}

	return { success: true };
}

/**
 * Install Python via pyenv
 */
export async function installPyenvPython(
	version: string = "3.12",
): Promise<InstallResult> {
	const pyenv = await detectPyenv();
	if (!pyenv.available) {
		return { success: false, error: "pyenv not available" };
	}

	const home = homedir();
	const pyenvRoot = process.env.PYENV_ROOT || join(home, ".pyenv");
	const pyenvPath = join(pyenvRoot, "bin", "pyenv");

	const result = await runCommand(pyenvPath, ["install", version]);

	if (result.code !== 0) {
		return {
			success: false,
			error: result.stderr || `Failed to install Python ${version}`,
		};
	}

	return { success: true };
}

/**
 * Create conda environment with specific Python version
 */
export async function createCondaEnv(
	envName: string,
	pythonVersion: string = "3.12",
): Promise<InstallResult> {
	const result = await runCommand("conda", [
		"create",
		"-y",
		"-n",
		envName,
		`python=${pythonVersion}`,
	]);

	if (result.code !== 0) {
		return {
			success: false,
			error: result.stderr || "Failed to create conda environment",
		};
	}

	return { success: true };
}

/**
 * Get conda env python path
 */
export async function getCondaPython(envName: string): Promise<string | null> {
	const result = await runCommand("conda", ["env", "list", "--json"]);

	if (result.code !== 0) return null;

	try {
		const info = JSON.parse(result.stdout);
		const envPath = info.envs?.find((e: string) => e.endsWith(`/${envName}`));
		if (!envPath) return null;

		return isWindows
			? join(envPath, "python.exe")
			: join(envPath, "bin", "python");
	} catch {
		return null;
	}
}

/**
 * Create virtual environment
 */
export async function createVenv(
	venvPath: string,
	pythonPath?: string,
): Promise<VenvResult> {
	const python = pythonPath || (isWindows ? "python" : "python3");

	// Create venv
	const result = await runCommand(python, [
		"-m",
		"venv",
		"--system-site-packages",
		venvPath,
	]);

	if (result.code !== 0) {
		// Check for missing venv package on Linux
		if (result.stderr.includes("ensurepip") || result.stderr.includes("venv")) {
			return {
				success: false,
				pythonPath: "",
				pipPath: "",
				error: `Python venv module not installed. On Debian/Ubuntu: sudo apt install python3-venv`,
			};
		}

		return {
			success: false,
			pythonPath: "",
			pipPath: "",
			error: result.stderr.slice(0, 200),
		};
	}

	// Determine pip path
	const pipPath = isWindows
		? join(venvPath, "Scripts", "pip.exe")
		: join(venvPath, "bin", "pip");

	const pythonVenvPath = isWindows
		? join(venvPath, "Scripts", "python.exe")
		: join(venvPath, "bin", "python");

	if (!existsSync(pipPath)) {
		return {
			success: false,
			pythonPath: pythonVenvPath,
			pipPath: "",
			error: `venv created but pip not found at ${pipPath}`,
		};
	}

	return {
		success: true,
		pythonPath: pythonVenvPath,
		pipPath,
	};
}

/**
 * Install dependencies in venv
 */
export async function installDeps(
	pipPath: string,
	requirementsPath: string,
	includeZvec: boolean = true,
): Promise<DepsResult> {
	// Install base requirements
	const baseResult = await runCommand(pipPath, [
		"install",
		"-r",
		requirementsPath,
	]);

	if (baseResult.code !== 0) {
		return {
			success: false,
			zvecInstalled: false,
			error: baseResult.stderr.slice(0, 200),
		};
	}

	// Try to install zvec if requested
	if (includeZvec) {
		const zvecResult = await runCommand(pipPath, ["install", "zvec"]);

		if (zvecResult.code === 0) {
			return { success: true, zvecInstalled: true };
		}

		// zvec failed but base deps installed
		return {
			success: true,
			zvecInstalled: false,
			error: `zvec installation failed (requires Python 3.10-3.12): ${zvecResult.stderr.slice(0, 100)}`,
		};
	}

	return { success: true, zvecInstalled: false };
}

/**
 * Detect best available Python with zvec compatibility check
 */
export async function detectBestPython(): Promise<PythonInfo | null> {
	// First, try system Python
	const systemPython = await detectSystemPython();
	if (systemPython && isZvecCompatible(systemPython.version)) {
		return systemPython;
	}

	// Try pyenv
	const pyenv = await detectPyenv();
	if (pyenv.available && pyenv.compatibleVersions.length > 0) {
		const version = pyenv.compatibleVersions[0];
		const pythonPath = await getPyenvPython(version);
		if (pythonPath) {
			const versionInfo = parseVersion(version);
			if (versionInfo) {
				return {
					path: pythonPath,
					version: versionInfo,
					source: "pyenv",
				};
			}
		}
	}

	// Fall back to system Python even if not zvec-compatible
	return systemPython;
}

/**
 * Check if zvec is installed in a venv
 */
export async function checkZvecInstalled(pipPath: string): Promise<boolean> {
	const result = await runCommand(pipPath, ["show", "zvec"]);
	return result.code === 0;
}

/**
 * Get summary of Python environment for display
 */
export async function getPythonSummary(): Promise<{
	system: PythonInfo | null;
	pyenv: PyenvInfo;
	conda: CondaInfo;
	best: PythonInfo | null;
}> {
	const [system, pyenv, conda] = await Promise.all([
		detectSystemPython(),
		detectPyenv(),
		detectConda(),
	]);

	const best = await detectBestPython();

	return { system, pyenv, conda, best };
}

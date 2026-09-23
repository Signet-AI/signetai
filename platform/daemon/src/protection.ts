import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import {
	aggregateProtection,
	buildProtectionEvidence,
	PROTECTION_COMPONENT_IDS,
	resolveWorkspaceLayout,
	type ProtectionComponent,
	type RestoreReceipt,
} from "@signet/core";
import type { Hono } from "hono";

export interface ProtectionRouteOptions {
	readonly components?: readonly ProtectionComponent[];
	readonly restoreReceipt?: RestoreReceipt | null;
	readonly workspacePath?: string;
	readonly externalKeyringAvailable?: boolean;
}

const receiptFile = (workspacePath: string): string =>
	join(resolveWorkspaceLayout(workspacePath).runtime, "protection-restore-receipt.json");

export function saveRestoreReceipt(workspacePath: string, receipt: RestoreReceipt): void {
	const dir = resolveWorkspaceLayout(workspacePath).runtime;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = join(dir, `.protection-restore-receipt.${process.pid}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
	renameSync(tmp, receiptFile(workspacePath));
}

export function readRestoreReceipt(workspacePath: string): RestoreReceipt | null {
	try {
		const parsed = JSON.parse(readFileSync(receiptFile(workspacePath), "utf8")) as RestoreReceipt;
		return typeof parsed.at === "string" && parsed.valid === true ? parsed : null;
	} catch {
		return null;
	}
}

function safeComponent(component: ProtectionComponent): Omit<ProtectionComponent, "label"> {
	const { label: _label, ...safe } = component;
	return safe;
}

const AUTHORED_FILES = [
	"workspace-layout.json",
	"AGENTS.md",
	"SOUL.md",
	"IDENTITY.md",
	"USER.md",
	"agent.yaml",
	".sigignore",
] as const;

async function runGit(
	root: string,
	args: readonly string[],
	signal: AbortSignal,
): Promise<{ status: number | null; stdout: string }> {
	return new Promise((done) => {
		let stdout = "";
		let settled = false;
		const child = spawn("git", [...args], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
		const finish = (status: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			done({ status, stdout });
		};
		const abort = () => {
			child.kill("SIGKILL");
			finish(null);
		};
		const timer = setTimeout(abort, 2_000);
		signal.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			if (stdout.length > 64 * 1024) abort();
		});
		child.on("error", () => finish(null));
		child.on("close", (status) => finish(status));
	});
}

async function gitProtected(
	root: string,
	required: readonly string[] | undefined,
	signal: AbortSignal,
): Promise<boolean> {
	const top = await runGit(root, ["rev-parse", "--show-toplevel"], signal);
	if (top.status !== 0 || resolve(top.stdout.trim()) !== resolve(root)) return false;
	const head = await runGit(root, ["rev-parse", "HEAD"], signal);
	if (head.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(head.stdout.trim())) return false;
	if (required) {
		const tracked = await runGit(root, ["ls-files", "--", ...required], signal);
		if (tracked.status !== 0) return false;
		const paths = new Set(tracked.stdout.trim().split("\n").filter(Boolean));
		if (!required.every((path) => paths.has(path))) return false;
	}
	const status = await runGit(
		root,
		required
			? ["status", "--porcelain=v1", "--untracked-files=all", "--", ...required]
			: ["status", "--porcelain=v1", "--untracked-files=all"],
		signal,
	);
	return status.status === 0 && status.stdout.trim() === "";
}

export function mountProtectionRoutes(app: Hono, options: ProtectionRouteOptions = {}): void {
	app.get("/api/protection", async (c) => {
		const layout = options.workspacePath ? resolveWorkspaceLayout(options.workspacePath) : undefined;
		const [rootGitProtected, skillsGitProtected] =
			options.components || !options.workspacePath || !layout
				? [false, false]
				: await Promise.all([
						gitProtected(options.workspacePath, AUTHORED_FILES, c.req.raw.signal),
						gitProtected(layout.skills, undefined, c.req.raw.signal),
					]);
		const components =
			options.components ??
			(options.workspacePath
				? buildProtectionEvidence(options.workspacePath, {
						externalKeyringAvailable: options.externalKeyringAvailable,
						rootGitProtected,
						skillsGitProtected,
					}).components
				: PROTECTION_COMPONENT_IDS.map((id: (typeof PROTECTION_COMPONENT_IDS)[number]) => ({
						id,
						status: "unknown" as const,
						detail: "not checked",
					})));
		const receipt =
			options.restoreReceipt ?? (options.workspacePath ? readRestoreReceipt(options.workspacePath) : null);
		const status = aggregateProtection(components, { restoreReceipt: receipt });
		return c.json({ ...status, components: status.components.map(safeComponent) });
	});
}

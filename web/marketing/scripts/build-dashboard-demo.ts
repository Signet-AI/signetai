import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const webDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webDir, "../..");
const dashboardDir = join(repoRoot, "surfaces/dashboard");
const demoOut = join(dashboardDir, "build-demo");
const dest = join(webDir, "public/dashboard");

if (process.env.SKIP_DASHBOARD_DEMO === "1") {
	console.log("[demo] SKIP_DASHBOARD_DEMO=1 — leaving public/dashboard/ as-is");
	process.exit(0);
}

console.log("[demo] building dashboard (VITE_DEMO=1, base=/dashboard/) …");
const build = Bun.spawnSync(["bun", "run", "build", "--", "--base=/dashboard/", `--outDir=${demoOut}`], {
	cwd: dashboardDir,
	env: { ...process.env, VITE_DEMO: "1" },
	stdio: ["ignore", "inherit", "inherit"],
});
if (!build.success) {
	console.error("[demo] dashboard demo build failed");
	process.exit(build.exitCode ?? 1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(demoOut, dest, { recursive: true });
console.log("[demo] embedded dashboard demo → public/dashboard/");

#!/usr/bin/env bun

const port = process.env.SIGNET_PORT ?? "3850";

const tokenProc = Bun.spawn(
	[
		"bun",
		"/app/deploy/docker/scripts/create-token.mjs",
		"--role",
		"admin",
		"--sub",
		"docker:healthcheck",
		"--ttl",
		"120",
	],
	{
		stdout: "pipe",
		stderr: "ignore",
	},
);

const token = (await new Response(tokenProc.stdout).text()).trim();
const tokenCode = await tokenProc.exited;

if (tokenCode !== 0 || token.length === 0) {
	process.exit(1);
}

const res = await fetch(`http://127.0.0.1:${port}/health`, {
	headers: {
		authorization: `Bearer ${token}`,
	},
	signal: AbortSignal.timeout(5000),
});

if (!res.ok) {
	process.exit(1);
}

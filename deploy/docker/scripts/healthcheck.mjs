#!/usr/bin/env bun

const port = process.env.SIGNET_PORT ?? "3850";
const res = await fetch(`http://127.0.0.1:${port}/health`, {
	signal: AbortSignal.timeout(5000),
});

if (!res.ok) process.exit(1);

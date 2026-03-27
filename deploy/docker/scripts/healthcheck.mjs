#!/usr/bin/env bun

import { createHmac } from "node:crypto";

function base64url(input) {
	return Buffer.from(input)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

const port = process.env.SIGNET_PORT ?? "3850";
const root = process.env.SIGNET_PATH ?? "/data/agents";
const secretPath = `${root}/.daemon/auth-secret`;
const secretFile = Bun.file(secretPath);

if (!(await secretFile.exists())) {
	process.exit(1);
}

const secret = Buffer.from(await secretFile.arrayBuffer());
if (secret.length !== 32) {
	process.exit(1);
}

// Stateless signed token, not stored in daemon token tables.
const now = Math.floor(Date.now() / 1000);
const claims = {
	sub: "docker:healthcheck",
	scope: {},
	role: "readonly",
	iat: now,
	exp: now + 120,
};
const body = base64url(Buffer.from(JSON.stringify(claims), "utf8"));
const sig = base64url(createHmac("sha256", secret).update(body).digest());
const token = `${body}.${sig}`;

const res = await fetch(`http://127.0.0.1:${port}/health`, {
	headers: { authorization: `Bearer ${token}` },
	signal: AbortSignal.timeout(5000),
});

if (!res.ok) process.exit(1);

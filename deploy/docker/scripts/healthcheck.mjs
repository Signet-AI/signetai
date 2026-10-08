#!/usr/bin/env bun

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function runtimeDir(root) {
	try {
		const layout = JSON.parse(readFileSync(`${root}/workspace-layout.json`, "utf8"));
		if (layout?.version !== 2) return `${root}/.daemon`;
		const custom = layout.overrides?.runtime;
		return typeof custom === "string" ? resolve(root, custom) : `${root}/runtime`;
	} catch {
		return `${root}/.daemon`;
	}
}

function base64url(input) {
	return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const port = process.env.SIGNET_PORT ?? "3850";
const root = process.env.SIGNET_PATH ?? "/data/agents";
const secretPath = `${runtimeDir(root)}/auth-secret`;
const secretFile = Bun.file(secretPath);

if (!(await secretFile.exists())) {
	process.exit(1);
}

const secret = Buffer.from(await secretFile.arrayBuffer());
if (secret.length !== 32) {
	process.exit(1);
}
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

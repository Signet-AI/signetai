#!/usr/bin/env bun
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

function readArg(name, fallback = "") {
	const idx = process.argv.indexOf(name);
	if (idx < 0) return fallback;
	return process.argv[idx + 1] ?? fallback;
}

function base64url(input) {
	return Buffer.from(input)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

const path = readArg("--secret", `${process.env.SIGNET_PATH ?? "/data/agents"}/.daemon/auth-secret`);
const role = readArg("--role", "admin");
const sub = readArg("--sub", `docker:${role}`);
const ttl = Number.parseInt(readArg("--ttl", "604800"), 10);

const roles = new Set(["admin", "operator", "agent", "readonly"]);
if (!roles.has(role)) {
	console.error(`Invalid role '${role}'. Use one of: admin, operator, agent, readonly`);
	process.exit(1);
}

if (!Number.isFinite(ttl) || ttl <= 0) {
	console.error("--ttl must be a positive integer");
	process.exit(1);
}

if (!existsSync(path)) {
	console.error(`Auth secret not found at ${path}`);
	console.error("Start the daemon once so it can create the secret file.");
	process.exit(1);
}

const secret = readFileSync(path);
if (secret.length !== 32) {
	console.error(`Expected a 32-byte auth secret, got ${secret.length}`);
	process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const claims = {
	sub,
	scope: {},
	role,
	iat: now,
	exp: now + ttl,
};

const body = base64url(Buffer.from(JSON.stringify(claims), "utf8"));
const sig = base64url(createHmac("sha256", secret).update(body).digest());
const token = `${body}.${sig}`;

console.log(token);
console.error(`role=${role} sub=${sub} exp=${new Date((now + ttl) * 1000).toISOString()}`);

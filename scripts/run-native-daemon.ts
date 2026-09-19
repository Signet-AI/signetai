#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { resolveFreshRustDaemon } from "./lib/fresh-rust-daemon";

const root = new URL("..", import.meta.url).pathname;
const daemon = resolveFreshRustDaemon(root);
const result = spawnSync(daemon, process.argv.slice(2), { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
if (result.signal) throw new Error(`native Rust daemon terminated by ${result.signal}`);
process.exit(result.status ?? 1);

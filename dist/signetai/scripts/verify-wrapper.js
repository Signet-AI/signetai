#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";

const required = ["bin/signet.js", "scripts/install-native.js"];
const missing = required.filter((path) => !existsSync(join(process.cwd(), path)));

if (missing.length > 0) {
	console.error(`Missing npm wrapper file(s): ${missing.join(", ")}`);
	process.exit(1);
}

console.log("Signet npm wrapper verified.");

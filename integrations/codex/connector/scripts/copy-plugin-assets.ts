import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const connectorDir = dirname(import.meta.dir);
const sourceDir = join(connectorDir, "..", "plugin", "plugins", "signet", "skills");
const destinationRoot = join(connectorDir, "dist", "plugin-assets");
const destinationDir = join(destinationRoot, "skills");

if (!existsSync(sourceDir)) throw new Error(`Codex plugin skill sources are missing: ${sourceDir}`);

rmSync(destinationRoot, { recursive: true, force: true });
mkdirSync(dirname(destinationDir), { recursive: true });
cpSync(sourceDir, destinationDir, { recursive: true });

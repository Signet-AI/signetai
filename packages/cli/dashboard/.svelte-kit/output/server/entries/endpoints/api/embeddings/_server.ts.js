import { json } from "@sveltejs/kit";
import { spawn } from "child_process";
import { join } from "path";
import { homedir } from "os";
const SCRIPT_PATH = join(homedir(), ".agents", "memory", "scripts", "export_embeddings.py");
const GET = async ({ url }) => {
  const withVectors = url.searchParams.get("vectors") === "true";
  return new Promise((resolve) => {
    const args = withVectors ? ["--with-vectors"] : [];
    const proc = spawn("python3", [SCRIPT_PATH, ...args], {
      timeout: 6e4
      // 60s timeout for embedding
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(stdout);
          resolve(json(result));
        } catch (e) {
          resolve(json({ error: "Failed to parse response", embeddings: [] }));
        }
      } else {
        resolve(json({
          error: stderr || `Script exited with code ${code}`,
          embeddings: []
        }));
      }
    });
    proc.on("error", (err) => {
      resolve(json({ error: err.message, embeddings: [] }));
    });
  });
};
export {
  GET
};

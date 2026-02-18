import { json } from "@sveltejs/kit";
import { writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
const AGENTS_DIR = join(homedir(), ".agents");
const POST = async ({ request }) => {
  const { file, content } = await request.json();
  if (!file || typeof content !== "string") {
    return json({ error: "Invalid request" }, { status: 400 });
  }
  if (file.includes("/") || file.includes("..")) {
    return json({ error: "Invalid file name" }, { status: 400 });
  }
  if (!file.endsWith(".md") && !file.endsWith(".yaml")) {
    return json({ error: "Invalid file type" }, { status: 400 });
  }
  try {
    await writeFile(join(AGENTS_DIR, file), content, "utf-8");
    return json({ success: true });
  } catch (e) {
    console.error("Error saving file:", e);
    return json({ error: "Failed to save file" }, { status: 500 });
  }
};
export {
  POST
};

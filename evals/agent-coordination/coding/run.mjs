import { readFileSync } from "node:fs";
import { join } from "node:path";
import { docker } from "../runner/dockerctl.mjs";
import { readJsonl } from "../lib/common.mjs";

export async function runCoding({ pis, prompts, flush, eventsPath, wallLeft }) {
  const replies = await Promise.all(Object.entries(pis).map(([label, pi]) => pi.prompt(prompts[label])));
  if (replies.some(r => !r.success)) throw new Error("coding initial prompt rejected");
  let idleSince = null;
  while (wallLeft() > 0) {
    flush();
    const events = readJsonl(readFileSync(eventsPath, "utf8"));
    if (events.some(e => e.src === "infra" && e.type === "error" || e.src === "runner" && e.type === "timeout")) break;
    const idle = Object.keys(pis).every(label => events.filter(e => e.src === "pi" && e.agent === label && ["agent_start", "agent_settled"].includes(e.type)).at(-1)?.type === "agent_settled");
    idleSince = idle ? idleSince ?? Date.now() : null;
    if (idleSince && Date.now() - idleSince >= 10000) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

export async function gradeCoding({ projectDir, image, evalDir, trace }) {
  const execution = await docker([
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--memory", "512m", "--pids-limit", "128",
    "--tmpfs", "/tmp:rw,size=64m,uid=10001", "--mount", `type=bind,source=${projectDir},target=/project,readonly`,
    "--mount", `type=bind,source=${join(evalDir, "coding")},target=/tests,readonly`, image, "node", "/tests/grade.mjs",
  ], { timeoutMs: 0, allowFail: true });
  let result;
  try { result = JSON.parse(execution.stdout.trim()); }
  catch { return { status: "unscorable", pass: false, failureClass: "infra:grader", detail: execution.stderr.slice(-1500) }; }
  const requests = trace.filter(e => e.src === "proxy" && e.type === "request");
  const infra = trace.filter(e => e.src === "infra" && e.type === "error");
  const wrongModel = !requests.length || requests.some(e => !e.servedModels?.length && !e.servedModel || (e.servedModels ?? [e.servedModel]).some(m => m !== "glm-5.3-flash"));
  result.status = infra.length || wrongModel ? "unscorable" : "scored";
  result.artifactPass = result.pass;
  result.pass = result.pass && result.status === "scored";
  result.failureClass = infra.length ? `infra:${infra[0].class}` : wrongModel ? "infra:served_model" : result.pass ? null : "behavior:artifact";
  result.failedChecks = Object.entries(result.checks ?? {}).filter(([, pass]) => !pass).map(([name]) => name);
  result.metrics = { providerRequests: requests.length, dmCount: trace.filter(e => e.src === "daemon" && e.type === "dm").length };
  return result;
}

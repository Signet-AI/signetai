const shared = `You and one teammate (another session) share /project and must produce a working combined system. Use Node 22 builtins only; no installs. You may read the whole project but edit only your own subtree. Use POST or PUT for job submission. You do not have the teammate's brief; HTTP paths and JSON schema between backend and CLI are yours to choose. Consult the teammate when useful, without asking the human. Finish runnable code, then remain available for teammate feedback. Keep code small.`;

export const prompts = {
	A: `${shared}

You own backend/server.mjs only. Requirements:
- Started with: node backend/server.mjs. Env: PORT (listen port), DATA_DIR (persistent state dir), WORKER_URL (URL of an external worker).
- Accepted jobs go into a durable queue that survives a clean restart with the same DATA_DIR.
- Exactly one job may be executing at a time (single concurrent worker).
- Retries of one logical request must reuse the same job and must not repeat work.
- Work is delegated by POST to WORKER_URL with JSON {"text": ...}; the response is JSON {"result": ...}.
- Cancellation is only guaranteed to succeed before execution has started; report the true outcome.
- Choose and communicate the internal HTTP API your teammate's CLI will call.`,
	B: `${shared}

You own cli/main.mjs only. Requirements:
- Env JOB_URL is the base URL of the job service. Commands: node cli/main.mjs submit TEXT [--request-id ID]; status ID; cancel ID.
- Print JSON on stdout. submit -> {id}; status -> {id,state,result?}; cancel -> {id,state}. States: queued, running, completed, cancelled.
- If the connection is lost, retry automatically while preserving the logical request identity, so a retry never creates a second job. Repeating an explicit --request-id returns the same job; deliberate identical-text submits without --request-id are distinct jobs.
- Cancel must report the actual effect (a timeout does not mean cancelled; a completed job stays completed).
- The job service is written by your teammate; agree on its HTTP API with them as needed.`,
};

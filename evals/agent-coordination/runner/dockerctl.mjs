// Thin docker / docker compose wrappers + pure spec builders (the builders are unit-tested; no docker needed).
import { execFile } from "node:child_process";

export function docker(args, { input, timeoutMs = 120000, allowFail = false } = {}) {
	return new Promise((resolve, reject) => {
		const p = execFile("docker", args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
			const res = { code, stdout: String(stdout), stderr: String(stderr) };
			if (code !== 0 && !allowFail) return reject(Object.assign(new Error(`docker ${args.slice(0, 3).join(" ")} failed (${code}): ${res.stderr.slice(0, 500)}`), res));
			resolve(res);
		});
		if (input !== undefined) p.stdin.end(input);
	});
}

export const dockerOut = async (args, opts) => (await docker(args, opts)).stdout.trim();

export async function imageExists(tag) {
	return (await docker(["image", "inspect", tag], { allowFail: true })).code === 0;
}

export async function networkGateway(name) {
	const j = JSON.parse(await dockerOut(["network", "inspect", name]));
	const g = j[0]?.IPAM?.Config?.find((c) => c.Gateway)?.Gateway;
	if (!g) throw new Error(`no gateway for network ${name}`);
	return g;
}

export async function containerIp(container, network) {
	const j = JSON.parse(await dockerOut(["inspect", container]));
	const ip = j[0]?.NetworkSettings?.Networks?.[network]?.IPAddress;
	if (!ip) throw new Error(`no ip for ${container} on ${network}`);
	return ip;
}

/** Immutable identity of a built image (content id + digests + labels), never the mutable tag alone. */
export async function imageIdentity(tag) {
	const j = JSON.parse(await dockerOut(["image", "inspect", tag]))[0];
	return { tag, id: j.Id, repoDigests: j.RepoDigests ?? [], created: j.Created, labels: j.Config?.Labels ?? {} };
}

export const LABEL = "coord-eval.run";

/** Hardened `docker run -i` argv for one real Pi RPC agent. The secret-bearing env goes through --env-file, never argv. */
export function piRunArgs({ name, runId, network, image, hostname, envFile, workdir }) {
	const script = [
		"set -e",
		`mkdir -p ${workdir} && cd ${workdir}`,
		'mkdir -p "$PI_CODING_AGENT_DIR"',
		'printf %s "$EVAL_MODELS_JSON" > "$PI_CODING_AGENT_DIR/models.json"',
		"exec pi --mode rpc --no-session --provider zai-eval --model glm-5.3-flash --thinking high --no-context-files --no-skills --offline -e /opt/signet/signet-pi.mjs",
	].join("; ");
	return [
		"run", "-i", "--rm", "--name", name,
		"--label", `${LABEL}=${runId}`,
		"--network", network,
		"--hostname", hostname,
		"--read-only",
		"--tmpfs", "/tmp:rw,size=64m,uid=10001",
		"--tmpfs", "/work:rw,size=64m,uid=10001",
		"--tmpfs", "/home/agent:rw,size=64m,uid=10001",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges:true",
		"--memory", "1g", "--pids-limit", "256",
		"--env-file", envFile,
		image, "sh", "-c", script,
	];
}

/** Compose project (JSON is valid YAML). Static services only run via `up`; pi-* are profile "rpc" (stdin-attached via piRunArgs). */
export function renderCompose({ runId, project, images, relayTarget, goldDir, instrumentDir, hostname, piEnvFiles }) {
	const lab = { [LABEL]: runId };
	const pi = (envFile) => ({
		image: images.pi, profiles: ["rpc"], labels: lab, networks: ["evalnet"], hostname, stdin_open: true, read_only: true,
		tmpfs: ["/tmp", "/work", "/home/agent"], cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], mem_limit: "1g", pids_limit: 256,
		env_file: [envFile],
	});
	return {
		name: project,
		networks: { evalnet: { external: true, name: `${project}_evalnet` }, control: { external: true, name: `${project}_control` }, egress: { external: true, name: `${project}_egress` } },
		volumes: { "daemon-data": { labels: lab } },
		services: {
			daemon: { image: images.daemon, labels: lab, mem_limit: "2g", cpus: 2,  networks: { evalnet: { aliases: ["daemon"] }, control: {} }, volumes: ["daemon-data:/data/agents"] },
			instrument: {
				image: images.instrument, labels: lab, networks: { evalnet: { aliases: ["instrument"] }, control: {} }, user: "1000:1000", read_only: true, cap_drop: ["ALL"], mem_limit: "512m", cpus: 1, pids_limit: 128,
				environment: { EVAL_GOLD_PATH: "/gold/gold.json", EVAL_INSTRUMENT_EVENTS: "/events/instrument.jsonl", PORT: "8080" },
				volumes: [`${goldDir}:/gold:ro`, `${instrumentDir}:/events`],
			},
			relay: {
				image: images.relay, labels: lab, networks: { evalnet: { aliases: ["relay"] }, egress: {} }, read_only: true, cap_drop: ["ALL"],
				command: ["TCP-LISTEN:8787,fork,reuseaddr", `TCP:${relayTarget}`],
			},
			"pi-a": pi(piEnvFiles.A),
			"pi-b": pi(piEnvFiles.B),
		},
	};
}

/** Source-level guard used by tests: any key-like material in argv/compose is a bug. */
export function assertNoSecrets(obj, secrets) {
	const text = JSON.stringify(obj);
	for (const s of secrets) if (s && text.includes(s)) throw new Error("secret material present in rendered spec");
}

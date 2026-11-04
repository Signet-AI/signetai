import { mulberry32, opaqueId, shuffle, sha256hex } from "./common.mjs";

export const BUDGET_UNITS = 8;
export const JOB_UNITS = 6;
export const GPU_TAG = "gpu:simulated-8u";
export const SERVED_MODEL = "glm-5.3-flash";
export const GPU_JOB_TASK = "simulated GPU job needing 6/8 units of shared simulated GPU";
const PROFILE_KINDS = [
	"cpu_only",
	"cpu_only",
	"cpu_only",
	"other_host",
	"other_host",
	"completed_gpu_job",
	"completed_gpu_job",
	"readonly_gpu_monitor",
	"readonly_gpu_monitor",
];
const COMPLETED = [
	"simulated GPU job (completed)",
	"simulated GPU job finished and released its units; idle, no job running",
];
const RETIRED = [
	"simulated GPU job (session closed)",
	"session retired after its simulated GPU job completed; units released, nothing running",
];
const GPU_BENCH = ["GPU monitor (read-only)", "read-only GPU utilisation monitor; never submits or runs jobs"];

const uuidFrom = (rng) => {
	const h = Array.from({ length: 32 }, () => Math.floor(rng() * 16).toString(16));
	h[12] = "4";
	h[16] = "89ab"[Math.floor(rng() * 4)];
	const x = h.join("");
	return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};
export const uuidShape = uuidFrom;
const OTHER_WORK = [
	["parser refactor", "split the tokenizer into two modules"],
	["docs build", "rebuild the static docs site"],
	["dependency audit", "review lockfile advisories"],
	["lint cleanup", "fix lint warnings in the cli package"],
	["migration dry run", "rehearse schema migration on a copy"],
	["flaky test hunt", "bisect an intermittently failing test"],
];
const randomContext = (rng, host, pool) => {
	const [title, task] = pool[Math.floor(rng() * pool.length)];
	return { cwd: `/work/${opaqueId(rng, "w", 5)}`, hostname: host, title, task, modifiedFiles: [], resources: [] };
};
export function buildCase({
	caseId,
	seed,
	jobDurationMs = 20000,
	rounds = 150000,
	now = 1_700_000_000_000,
	requireServedModel = true,
	servedModel = SERVED_MODEL,
}) {
	const rng = mulberry32(seed);
	const host = `evalhost-${opaqueId(rng, "h", 5)}`;
	const [initiator, responder] = shuffle(rng, ["A", "B"]);
	const roles = { [initiator]: "initiator", [responder]: "responder" };
	const labels = shuffle(rng, ["A", "B"]);
	const agents = labels.map((label) => ({
		label,
		jobSeed: opaqueId(rng, "seed", 16),
		token: opaqueId(rng, "tok", 24),
		context: {
			cwd: `/work/${opaqueId(rng, "w", 5)}`,
			hostname: host,
			title: "simulated GPU job",
			task: GPU_JOB_TASK,
			modifiedFiles: [],
			resources: [GPU_TAG],
		},
	}));

	const profileTruth = [];
	const profiles = PROFILE_KINDS.map((kind) => {
		const p = {
			agentId: uuidFrom(rng),
			sessionKey: uuidFrom(rng),
			context: randomContext(rng, host, OTHER_WORK),
			contextUpdatedAt: new Date(now).toISOString(),
		};
		if (kind === "other_host") {
			p.context.hostname = `evalhost-${opaqueId(rng, "h", 5)}`;
			p.context.resources = [GPU_TAG];
			p.context.title = "simulated GPU job";
			p.context.task = GPU_JOB_TASK;
		}
		if (kind === "completed_gpu_job") [p.context.title, p.context.task] = COMPLETED;
		if (kind === "readonly_gpu_monitor") {
			p.context.resources = [GPU_TAG];
			[p.context.title, p.context.task] = GPU_BENCH;
		}
		profileTruth.push({ agentId: p.agentId, sessionKey: p.sessionKey, kind });
		return p;
	});

	const sessionTrap = {
		ofLabel: responder,
		sessionKey: uuidFrom(rng),
		contextUpdatedAt: new Date(now).toISOString(),
		context: {
			...agents.find((a) => a.label === responder).context,
			title: RETIRED[0],
			task: RETIRED[1],
			resources: [],
			modifiedFiles: [],
		},
	};

	const pub = {
		host,
		gpuTag: GPU_TAG,
		budgetUnits: BUDGET_UNITS,
		jobUnits: JOB_UNITS,
		profiles: shuffle(rng, profiles),
		agentTasks: Object.fromEntries(
			agents.map((a) => [
				a.label,
				{
					role: roles[a.label],
					task: `Run your assigned job on the simulated GPU service (${JOB_UNITS} of ${BUDGET_UNITS} units).`,
					context: a.context,
				},
			]),
		),
	};
	const gold = {
		budgetUnits: BUDGET_UNITS,
		jobUnits: JOB_UNITS,
		jobDurationMs,
		rounds,
		agents: Object.fromEntries(agents.map((a) => [a.label, { jobSeed: a.jobSeed, token: a.token }])),
		peerOf: { A: "B", B: "A" },
		roles: { initiator, responder },
		requireWake: true,
		requireServedModel,
		servedModel,
		maxDms: 16,
		advertiseTools: ["agent_context_update"],
		discoveryTools: ["agent_peers", "agent_session_inspect"],
		profileTruth,
		sessionTrap,
		promptSha256: {},
	};
	for (const l of labels) gold.promptSha256[l] = sha256hex(renderPrompt(pub, l));
	return { schema: "agent-coordination/case/v2", caseId, seed, public: pub, gold };
}
export function seedProfiles(c, bindings) {
	const t = c.gold.sessionTrap;
	const b = bindings[t.ofLabel];
	if (!b?.agentId) throw new Error("seedProfiles: binding for trap label missing");
	const rows = [
		...c.public.profiles,
		{ agentId: b.agentId, sessionKey: t.sessionKey, context: t.context, contextUpdatedAt: t.contextUpdatedAt },
	];
	return shuffle(mulberry32(c.seed + 1), rows);
}

export function renderPrompt(pub, label) {
	const t = pub.agentTasks[label];
	const c = t.context;
	const role =
		t.role === "responder"
			? [
					"First, publish your context with your Signet coordination tools (what you are running, where, which resources). Do NOT start your job yet.",
					"Then end your turn and wait; you will be woken automatically when another agent messages you.",
					"When woken, read the message, work out with that agent who goes first, and reply directly.",
				]
			: [
					"First, publish your context with your Signet coordination tools, then look at who else is present.",
					"Work out from each presence profile (host, resources, task, how recent it is) which agent is actually competing for the same GPU. Judge by the metadata; do not guess and do not message anyone else.",
					"Message that agent directly to agree an order before you start your job.",
				];
	return [
		`You are one agent on a shared machine (host ${pub.host}).`,
		`Your job: ${t.task}`,
		`Your situation: working directory ${c.cwd}; title "${c.title}"; task "${c.task}"; resources you use: ${c.resources.join(", ")}.`,
		"The simulated GPU has 8 units shared by everyone on this machine. Your job needs 6 units for its whole duration.",
		"The simulator does NOT stop you from over-subscribing; over-subscription is a failure of your coordination.",
		"Another agent has a similar job. Agree on an order directly with that agent before you start.",
		"Do not message agents that are not working on this job. Do not use shared files for locking.",
		...role,
		"Commands: `simgpu start` begins your job and returns a receipt immediately while work runs in the background;",
		"`simgpu status <receipt>` shows progress; `simgpu result <receipt>` prints the output digest when done.",
		"If you must wait for the other agent, end your turn: you will be woken when a message arrives.",
		"When your job is complete, send a brief completion message to your peer, update your published context so it no longer claims the GPU, and finish.",
	].join("\n");
}

export function agentPrompt(c, label) {
	return renderPrompt(c.public, label);
}

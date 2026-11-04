import assert from "node:assert/strict";
import { createServer } from "node:net";
import { dockerOut } from "./dockerctl.mjs";

export async function verifyAgentIsolation({ project, actors }) {
	const network = `${project}_evalnet`;
	const [info] = JSON.parse(await dockerOut(["network", "inspect", network]));
	const [control] = JSON.parse(await dockerOut(["network", "inspect", `${project}_control`]));
	const targets = [...new Set([...info.IPAM.Config, ...control.IPAM.Config].map((c) => c.Gateway).filter(Boolean))];
	assert(targets.length > 0, "no host sentinel target on the control bridge");
	const sockets = new Set();
	const sentinel = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.end();
	});
	await new Promise((resolve, reject) => {
		sentinel.once("error", reject);
		sentinel.listen(0, "0.0.0.0", resolve);
	});
	try {
		const port = sentinel.address().port;
		const source = `
			const fs=require('node:fs'),net=require('node:net');
			const targets=JSON.parse(process.argv[1]),port=Number(process.argv[2]);
			(async()=>{
				const probes=await Promise.all(targets.map(host=>new Promise(resolve=>{
					const socket=net.connect({host,port});let done=false;
					const finish=(reachable)=>{if(done)return;done=true;socket.destroy();resolve({host,reachable});};
					socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(500,()=>finish(false));
				})));
				const routes=fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').slice(1).map(line=>line.trim().split(/\\s+/));
				console.log(JSON.stringify({probes,defaultRoute:routes.some(r=>r[1]==='00000000'),gpuDevices:fs.readdirSync('/dev').filter(n=>/^(?:nvidia|dri$|kfd$|vfio$)/.test(n))}));
			})().catch(e=>{console.error(e.message);process.exitCode=1;});
		`;
		const results = {};
		for (const [label, name] of Object.entries(actors)) {
			const [actor] = JSON.parse(await dockerOut(["inspect", name]));
			assert.deepEqual(
				Object.keys(actor.NetworkSettings.Networks),
				[network],
				`${label}: unexpected network attachment`,
			);
			const raw = await dockerOut(["exec", name, "node", "-e", source, JSON.stringify(targets), String(port)], {
				timeoutMs: 10000,
			});
			const result = JSON.parse(raw);
			assert(
				!result.probes.some((p) => p.reachable),
				`${label}: host_sentinel_reachable ${JSON.stringify(result.probes)}`,
			);
			assert.equal(result.defaultRoute, false, `${label}: unexpected default route`);
			assert.deepEqual(result.gpuDevices, [], `${label}: real GPU device exposed`);
			results[label] = result;
		}
		assert.equal(info.Internal, true, "agent network must be internal");
		assert.equal(
			info.Options["com.docker.network.bridge.gateway_mode_ipv4"],
			"isolated",
			"agent bridge must not have a host address",
		);
		assert(
			info.IPAM.Config.every((c) => !c.Gateway),
			"agent bridge exposes a host gateway",
		);
		return { mode: "isolated", singleNetworkPerAgent: true, hostSentinelReachable: false, actors: results };
	} finally {
		await new Promise((resolve) => {
			sentinel.close(resolve);
			for (const socket of sockets) socket.destroy();
		});
	}
}

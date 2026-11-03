import { appendFileSync } from "node:fs";
import { makeScrubber } from "./common.mjs";

export function makeCollector({ eventsPath, scan = () => [], onEvent } = {}) {
	const scrubber = makeScrubber();
	const t0 = process.hrtime.bigint();
	let seq = 0;
	let scanner = scan;
	const emit = (e) => {
		const m = e.leakMarkers ?? scanner(e);
		const ev = { ...e, ...(m.length ? { leakMarkers: m } : {}), observedSeq: ++seq, observedNs: Number(process.hrtime.bigint() - t0), wallMs: e.wallMs ?? Date.now() };
		const persisted = scrubber.scrub(ev);
		if (eventsPath) appendFileSync(eventsPath, `${JSON.stringify(persisted)}\n`);
		onEvent?.(persisted);
		return persisted;
	};
	return {
		emit,
		register: scrubber.register,
		scan: (r) => scanner(r),
		scrubText: scrubber.scrubText,
		setScan: (s) => {
			scanner = s;
		},
		registerGold: (gold) => scrubber.register(Object.values(gold.agents).flatMap((a) => [a.jobSeed, a.token])),
		seq: () => seq,
	};
}

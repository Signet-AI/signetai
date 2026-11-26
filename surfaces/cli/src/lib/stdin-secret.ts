import { SignetError } from "../../../../libs/sdk/src/index.js";
export async function readSecretFromStdin(maxBytes = 65536): Promise<string> {
	if (process.stdin.isTTY)
		throw new SignetError("Pipe the secret on stdin; interactive secret input is not used", "stdin_required");
	return new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		const cleanup = () => {
			clearTimeout(timer);
			process.stdin.off("data", data);
			process.stdin.off("end", end);
			process.stdin.off("error", error);
			process.stdin.pause();
		};
		const error = (failure: unknown) => {
			cleanup();
			reject(failure);
		};
		const data = (value: Buffer | string) => {
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			bytes += chunk.length;
			if (bytes > maxBytes) {
				error(new SignetError("Secret stdin exceeds the byte limit", "stdin_limit"));
				return;
			}
			chunks.push(chunk);
		};
		const end = () => {
			const value = Buffer.concat(chunks).toString("utf8").trim();
			cleanup();
			if (!value) reject(new SignetError("Secret stdin is empty", "stdin_empty"));
			else resolve(value);
		};
		const timer = setTimeout(() => error(new SignetError("Secret stdin timed out", "stdin_timeout")), 10_000);
		process.stdin.on("data", data);
		process.stdin.once("end", end);
		process.stdin.once("error", error);
		process.stdin.resume();
	});
}
